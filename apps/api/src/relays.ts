/**
 * Relay channels and person links (review of wave 2, docs/approvals.md "Relays"). A relay never names who decided: it
 * carries the raw interaction a channel sent (Slack's body and its `X-Slack-Signature` and timestamp), and Landledger
 * verifies it with the channel's own signing secret, checks the team and the app, reads the press, and finds the person
 * through a link that person made from their own signed-in session. Only Slack is implemented; the table has room for
 * Teams and email.
 */
import {
  type PersonLinkInput,
  type PersonLinkView,
  type RelayChannelInput,
  type RelayChannelKind,
  type RelayChannelView,
  SLACK_ACTIONS,
  parseSlackButtonValue,
} from '@landledger/contracts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuditLog } from './audit.js';
import type { Sql, Tx } from './db.js';
import { ApiError, notFound } from './errors.js';
import { newId } from './ids.js';
import { actorOf, type Principal } from './principal.js';
import type { SecretBox } from './secrets.js';

export const relayChannelAad = (id: string) => `relay_channels.secret:${id}`;

/** Slack's window for a request timestamp: five minutes either way. */
export const SLACK_WINDOW_S = 300;

interface ChannelRow {
  id: string;
  kind: RelayChannelKind;
  name: string;
  config: Record<string, string>;
  secret: string;
  created_by: string;
  created_at: Date;
  disabled_at: Date | null;
}

const viewOf = (r: ChannelRow): RelayChannelView => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  config: r.config,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  disabledAt: r.disabled_at?.toISOString() ?? null,
});

/** Slack's request signature: `v0=` hex HMAC-SHA256 of `v0:<timestamp>:<body>` under the signing secret. */
export function slackSignature(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

/** A press read from a verified Slack interaction. */
export interface SlackPress {
  outcome: 'approve' | 'reject';
  comment: string;
  requestId: string;
  step: number;
  evidenceSha256: string;
  userId: string;
  teamId: string;
  appId: string;
}

type SlackPayload = {
  type?: string;
  team?: { id?: string } | null;
  user?: { id?: string; team_id?: string };
  api_app_id?: string;
  actions?: { action_id?: string; value?: string }[];
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string | null }>> };
  };
};

/** The JSON a Slack interaction carries (`payload=` in a form-encoded body), before anything is trusted. */
export function slackPayloadOf(body: string): SlackPayload {
  const raw = new URLSearchParams(body).get('payload');
  if (!raw) throw new ApiError('bad_request', 'Not a Slack interaction: the body has no payload=');
  try {
    return JSON.parse(raw) as SlackPayload;
  } catch {
    throw new ApiError('bad_request', 'Not a Slack interaction: payload is not JSON');
  }
}

/** Reads the press of a verified payload: a button, or the reject modal with its comment. */
export function slackPressOf(p: SlackPayload): SlackPress {
  const teamId = p.team?.id ?? p.user?.team_id ?? '';
  const appId = p.api_app_id ?? '';
  const userId = p.user?.id ?? '';
  if (!userId) throw new ApiError('bad_request', 'The Slack interaction names no user');
  let outcome: 'approve' | 'reject';
  let value: string;
  let comment = '';
  if (p.type === 'block_actions') {
    const action = (p.actions ?? []).find(
      (a) => a.action_id === SLACK_ACTIONS.approve || a.action_id === SLACK_ACTIONS.reject,
    );
    if (!action?.value) throw new ApiError('bad_request', 'No Landledger button was pressed');
    outcome = action.action_id === SLACK_ACTIONS.approve ? 'approve' : 'reject';
    value = action.value;
  } else if (p.type === 'view_submission' && p.view?.callback_id === SLACK_ACTIONS.reject) {
    outcome = 'reject';
    value = p.view.private_metadata ?? '';
    comment =
      p.view.state?.values?.[SLACK_ACTIONS.commentBlock]?.[SLACK_ACTIONS.commentBlock]?.value?.toString().trim() ?? '';
  } else throw new ApiError('bad_request', `A Slack ${p.type ?? 'interaction'} Landledger doesn't read`);
  const card = parseSlackButtonValue(value);
  if (!card) throw new ApiError('bad_request', 'The button carries no Landledger card (ll1|request|step|sha256)');
  if (outcome === 'reject' && comment.length < 3)
    throw new ApiError('bad_request', 'Say why you reject it: open the reject form and write a reason');
  return { outcome, comment, ...card, userId, teamId, appId };
}

export class RelayChannels {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly box: SecretBox | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<RelayChannelView[]> {
    const rows = await this.sql<ChannelRow[]>`SELECT * FROM relay_channels ORDER BY created_at DESC`;
    return rows.map(viewOf);
  }

  async create(input: RelayChannelInput, by: Principal): Promise<RelayChannelView> {
    if (by.kind !== 'person') throw new ApiError('forbidden', 'A signed-in admin person registers a relay channel');
    const box = this.box;
    if (!box)
      throw new ApiError('unavailable', 'Relay secrets are sealed at rest: set LANDLEDGER_SECRET_KEY to add a channel');
    const id = newId('rch');
    const actor = actorOf(by);
    const config = { teamId: input.teamId, appId: input.appId };
    return (await this.sql.begin(async (tx) => {
      const [row] = await tx<ChannelRow[]>`
        INSERT INTO relay_channels (id, kind, name, config, secret, created_by)
        VALUES (${id}, ${input.kind}, ${input.name}, ${tx.json(config)},
                ${box.seal(input.signingSecret, relayChannelAad(id))}, ${actor.actor})
        RETURNING *`;
      await this.audit.append(
        {
          ...actor,
          action: 'relay_channel.created',
          subjectType: 'relay_channel',
          subjectId: id,
          data: { kind: input.kind, name: input.name, ...config },
        },
        tx,
      );
      return viewOf(row!);
    })) as RelayChannelView;
  }

  async disable(id: string, by: Principal): Promise<void> {
    if (by.kind !== 'person') throw new ApiError('forbidden', 'A signed-in admin person removes a relay channel');
    await this.sql.begin(async (tx) => {
      const rows = await tx`
        UPDATE relay_channels SET disabled_at = now() WHERE id = ${id} AND disabled_at IS NULL RETURNING id`;
      if (!rows.length) throw notFound('Relay channel');
      await this.audit.append(
        { ...actorOf(by), action: 'relay_channel.disabled', subjectType: 'relay_channel', subjectId: id },
        tx,
      );
    });
  }

  /**
   * Verifies a raw Slack interaction and reads its press: the channel (named, or the one whose team and app the
   * payload names), the signature under that channel's secret, the timestamp within 5 minutes, the team and the app.
   */
  async verifySlack(input: {
    channelId?: string;
    body: string;
    signature: string;
    timestamp: string;
  }): Promise<{ channel: RelayChannelView; press: SlackPress }> {
    const payload = slackPayloadOf(input.body);
    const team = payload.team?.id ?? payload.user?.team_id ?? null;
    const app = payload.api_app_id ?? null;
    const [row] = input.channelId
      ? await this.sql<ChannelRow[]>`
          SELECT * FROM relay_channels WHERE id = ${input.channelId} AND kind = 'slack' AND disabled_at IS NULL`
      : await this.sql<ChannelRow[]>`
          SELECT * FROM relay_channels WHERE kind = 'slack' AND disabled_at IS NULL
            AND config->>'teamId' = ${team ?? ''} AND config->>'appId' = ${app ?? ''}
          ORDER BY created_at DESC LIMIT 1`;
    if (!row) throw new ApiError('unauthorized', 'No Slack relay channel is registered for this team and app');
    if (!this.box) throw new ApiError('unavailable', 'LANDLEDGER_SECRET_KEY is not set: the channel secret is sealed');
    const secret = this.box.open(row.secret, relayChannelAad(row.id));
    const expected = Buffer.from(slackSignature(secret, input.timestamp, input.body));
    const given = Buffer.from(input.signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      throw new ApiError('unauthorized', "The Slack signature doesn't match this channel's signing secret");
    const skew = Math.abs(this.now().getTime() / 1000 - Number(input.timestamp));
    if (!(skew <= SLACK_WINDOW_S))
      throw new ApiError('unauthorized', 'The Slack request is older than 5 minutes (or from the future): refused');
    const press = slackPressOf(payload);
    if (press.teamId !== row.config.teamId || press.appId !== row.config.appId)
      throw new ApiError('unauthorized', 'The interaction comes from another Slack team or app than this channel');
    return { channel: viewOf(row), press };
  }
}

interface LinkRow {
  id: string;
  user_id: string;
  kind: RelayChannelKind;
  external_id: string;
  created_at: Date;
}

/** People's own links between a relay channel's user and themselves. */
export class PersonLinks {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
  ) {}

  private own(by: Principal): string {
    if (by.kind !== 'person' || !by.sessionId)
      throw new ApiError('forbidden', 'A person links their own account, signed in themselves; a key never does');
    return by.id;
  }

  async list(by: Principal): Promise<PersonLinkView[]> {
    const me = this.own(by);
    const rows = await this.sql<LinkRow[]>`
      SELECT * FROM person_links WHERE user_id = ${me} AND removed_at IS NULL ORDER BY created_at`;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      externalId: r.external_id,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async create(input: PersonLinkInput, by: Principal): Promise<PersonLinkView> {
    const me = this.own(by);
    return (await this.sql.begin(async (tx) => {
      const [taken] = await tx<{ user_id: string }[]>`
        SELECT user_id FROM person_links WHERE kind = ${input.kind} AND external_id = ${input.externalId}
          AND removed_at IS NULL FOR UPDATE`;
      if (taken && taken.user_id !== me)
        throw new ApiError('conflict', `That ${input.kind} account is linked to someone else`);
      const [mine] = await tx<LinkRow[]>`
        SELECT * FROM person_links WHERE user_id = ${me} AND kind = ${input.kind} AND removed_at IS NULL FOR UPDATE`;
      if (mine?.external_id === input.externalId)
        return { id: mine.id, kind: mine.kind, externalId: mine.external_id, createdAt: mine.created_at.toISOString() };
      if (mine) await tx`UPDATE person_links SET removed_at = now() WHERE id = ${mine.id}`;
      const [row] = await tx<LinkRow[]>`
        INSERT INTO person_links (id, user_id, kind, external_id)
        VALUES (${newId('lnk')}, ${me}, ${input.kind}, ${input.externalId}) RETURNING *`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'person_link.created',
          subjectType: 'user',
          subjectId: me,
          data: { kind: input.kind, externalId: input.externalId, replaced: mine?.external_id ?? null },
        },
        tx,
      );
      return { id: row!.id, kind: row!.kind, externalId: row!.external_id, createdAt: row!.created_at.toISOString() };
    })) as PersonLinkView;
  }

  async remove(id: string, by: Principal): Promise<void> {
    const me = this.own(by);
    await this.sql.begin(async (tx) => {
      const rows = await tx<LinkRow[]>`
        UPDATE person_links SET removed_at = now() WHERE id = ${id} AND user_id = ${me} AND removed_at IS NULL
        RETURNING *`;
      if (!rows.length) throw notFound('Link');
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'person_link.removed',
          subjectType: 'user',
          subjectId: me,
          data: { kind: rows[0]!.kind, externalId: rows[0]!.external_id },
        },
        tx,
      );
    });
  }

  /** The person linked to a channel user, if any. */
  async personFor(kind: RelayChannelKind, externalId: string, tx: Tx = this.sql): Promise<string | null> {
    const [row] = await tx<{ user_id: string }[]>`
      SELECT user_id FROM person_links WHERE kind = ${kind} AND external_id = ${externalId} AND removed_at IS NULL`;
    return row?.user_id ?? null;
  }
}
