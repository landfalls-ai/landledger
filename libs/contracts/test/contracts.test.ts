import { describe, expect, it } from 'vitest';
import { toWire } from '@landledger/focus';
import { aiInputRow } from '@landledger/focus/testing';
import { Money } from '@landledger/money';
import {
  ApiKeyInput,
  ApiScope,
  CostRecord,
  PersonLinkInput,
  RelayChannelInput,
  SlackRelayInput,
  parseSlackButtonValue,
  slackButtonValue,
  CreateRequestInput,
  DecisionInput,
  PolicyDef,
  RequesterInput,
  RequestOrigin,
  RequestStatus,
  WebhookEvent,
  MoneyJson,
  Period,
  RecordsQuery,
  ROLE_BY_GROUP,
  Role,
  SCOPES_BY_ROLE,
} from '../src/index.js';

describe('roles', () => {
  it('map the six Landbright finance groups and nothing else', () => {
    expect(ROLE_BY_GROUP).toEqual({
      'Finance CFO': 'cfo',
      'Finance Controllers': 'controller',
      'Finance FP&A': 'fpa',
      'Budget Owners': 'budget_owner',
      'Landledger Auditors': 'auditor',
      Engineering: 'engineer',
    });
    expect(ROLE_BY_GROUP['Everyone']).toBeUndefined();
  });

  it('give every role read, and only the CFO and controllers admin', () => {
    for (const role of Role.options) expect(SCOPES_BY_ROLE[role]).toContain('read');
    const admins = Role.options.filter((r) => SCOPES_BY_ROLE[r].includes('admin'));
    expect(admins.sort()).toEqual(['cfo', 'controller']);
    expect(SCOPES_BY_ROLE.auditor).toEqual(['read']);
  });
});

describe('wire values', () => {
  it('carry money as minor-unit strings', () => {
    expect(MoneyJson.safeParse({ amount: '-0.003100', currency: 'USD' }).success).toBe(true);
    expect(MoneyJson.safeParse(JSON.parse(JSON.stringify(Money.parse('7.2', 'USD')))).success).toBe(true);
    expect(MoneyJson.safeParse({ amount: 12.5, currency: 'USD' }).success).toBe(false);
    expect(MoneyJson.safeParse({ amount: '12.5', currency: 'usd' }).success).toBe(false);
    expect(MoneyJson.safeParse({ amount: '0.0000001', currency: 'USD' }).success).toBe(false);
    expect(MoneyJson.safeParse({ amount: '+1', currency: 'USD' }).success).toBe(false);
  });

  it('need a name and at least one known scope for a key', () => {
    expect(ApiKeyInput.safeParse({ name: 'ingest', scopes: ['ingest'] }).success).toBe(true);
    expect(ApiKeyInput.safeParse({ name: 'x', scopes: [] }).success).toBe(false);
    expect(ApiKeyInput.safeParse({ name: 'x', scopes: ['decide'] }).success).toBe(false);
  });
});

describe('cost records and periods on the wire (spec 001)', () => {
  it('takes a record as libs/focus writes it, with amounts as strings', () => {
    const wire = JSON.parse(JSON.stringify(toWire(aiInputRow())));
    expect(CostRecord.parse(wire)).toEqual(wire);
    expect(CostRecord.safeParse({ ...wire, EffectiveCost: 7.2 }).success).toBe(false);
    expect(CostRecord.safeParse({ ...wire, PricingQuantity: '2.4e0' }).success).toBe(false);
    expect(CostRecord.safeParse({ ...wire, ChargePeriodStart: '2026-11-13' }).success).toBe(false);
    expect(CostRecord.safeParse({ ...wire, x_Extra: 'no' }).success).toBe(false);
  });

  it('reads periods and record queries', () => {
    expect(Period.shape.status.options).toEqual(['open', 'closing', 'locked']);
    expect(RecordsQuery.parse({ month: '2026-11', limit: '50' })).toMatchObject({ month: '2026-11', limit: 50 });
    expect(RecordsQuery.safeParse({ month: '2026-13' }).success).toBe(false);
    expect(RecordsQuery.parse({}).limit).toBe(100);
  });
});

describe('wave 2: requests and decisions', () => {
  const base = {
    kind: 'infra_change',
    title: 'Add 3 replicas to landflow-host',
    costCenter: 'ENG-PLATFORM',
    amount: { amount: '1840', currency: 'USD' },
    recurrence: 'monthly',
  };

  it('takes a request with money as a string, and refuses floats and the self-applied kinds', () => {
    expect(CreateRequestInput.safeParse(base).success).toBe(true);
    expect(CreateRequestInput.safeParse({ ...base, amount: { amount: 1840, currency: 'USD' } }).success).toBe(false);
    expect(CreateRequestInput.safeParse({ ...base, kind: 'rate_card_change' }).success).toBe(false);
    expect(CreateRequestInput.safeParse({ ...base, start: '2026-11-20', end: '2026-11-01' }).success).toBe(false);
  });

  it('needs a sponsor for an agent, and a person by sub or email', () => {
    const agent = { kind: 'agent', agent: { id: 'ag_1', name: 'Triage lead' } };
    expect(RequesterInput.safeParse(agent).success).toBe(false);
    expect(RequesterInput.safeParse({ ...agent, sponsor: {} }).success).toBe(false);
    expect(RequesterInput.safeParse({ ...agent, sponsor: { email: 'omer@landbright.test' } }).success).toBe(true);
    expect(RequestOrigin.safeParse({ type: 'landflow_run', workflowId: 'wf_1', executionId: 'ex_1' }).success).toBe(
      true,
    );
  });

  it('needs a comment to reject, and the evidence hash always', () => {
    const sha = 'a'.repeat(64);
    expect(DecisionInput.safeParse({ outcome: 'approve', evidenceSha256: sha }).success).toBe(true);
    expect(DecisionInput.safeParse({ outcome: 'reject', evidenceSha256: sha }).success).toBe(false);
    expect(DecisionInput.safeParse({ outcome: 'reject', comment: 'Too much', evidenceSha256: sha }).success).toBe(true);
    expect(DecisionInput.safeParse({ outcome: 'approve' }).success).toBe(false);
  });

  it('keeps status forward-only in its order, and names the webhook events', () => {
    expect(RequestStatus.options).toEqual([
      'draft',
      'pending',
      'approved',
      'rejected',
      'cancelled',
      'expired',
      'applied',
      'awaiting_confirmation',
    ]);
    for (const e of ['request.created', 'request.step_pending', 'request.decided', 'request.applied', 'budget.at_risk'])
      expect(WebhookEvent.options).toContain(e);
    expect(
      PolicyDef.safeParse({
        kind: 'infra_change',
        automaticBelow: '500',
        steps: [{ key: 'budget_owner', label: 'Budget owner', approvers: { groups: ['Budget Owners'] }, when: {} }],
      }).success,
    ).toBe(true);
  });
});

describe('review of wave 2: relays, keys, confirmation', () => {
  it('never lets a relay key raise requests or administer, and knows webhooks:write', () => {
    expect(ApiScope.options).toContain('webhooks:write');
    expect(ApiKeyInput.safeParse({ name: 'relay', scopes: ['decisions:relay'] }).success).toBe(true);
    expect(ApiKeyInput.safeParse({ name: 'x', scopes: ['decisions:relay', 'requests:write'] }).success).toBe(false);
    expect(ApiKeyInput.safeParse({ name: 'x', scopes: ['decisions:relay', 'admin'] }).success).toBe(false);
    expect(ApiKeyInput.parse({ name: 'w', scopes: ['requests:write'] }).boundWorkflowIds).toEqual([]);
  });

  it('round-trips a Slack button value, and refuses anything else', () => {
    const v = { requestId: 'req_KKKMAdhv9Vr1Vp0f3KxS', step: 1, evidenceSha256: 'b'.repeat(64) };
    expect(parseSlackButtonValue(slackButtonValue(v))).toEqual(v);
    expect(parseSlackButtonValue('ll1|req_x|1|short')).toBeNull();
    expect(parseSlackButtonValue(`ll2|req_x|1|${'b'.repeat(64)}`)).toBeNull();
  });

  it('takes a Slack channel with its team and app, the raw relay, and a member id to link', () => {
    const channel = {
      kind: 'slack',
      name: 'Dev',
      signingSecret: 'x'.repeat(32),
      teamId: 'T_LANDDEV',
      appId: 'A_LANDLEDGER',
    };
    expect(RelayChannelInput.safeParse(channel).success).toBe(true);
    expect(RelayChannelInput.safeParse({ ...channel, teamId: 'landdev' }).success).toBe(false);
    expect(
      SlackRelayInput.safeParse({ body: 'payload=%7B%7D', signature: `v0=${'0'.repeat(64)}`, timestamp: '1763200000' })
        .success,
    ).toBe(true);
    expect(SlackRelayInput.safeParse({ body: 'x', signature: 'sha256=1', timestamp: '1' }).success).toBe(false);
    expect(PersonLinkInput.safeParse({ kind: 'slack', externalId: 'U_SHIRA' }).success).toBe(true);
    expect(PersonLinkInput.safeParse({ kind: 'slack', externalId: 'shira' }).success).toBe(false);
  });
});
