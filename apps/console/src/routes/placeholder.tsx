import type { AuditVerify } from '@landledger/contracts';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { Card, CardBody } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { get, quiet } from '@/lib/api';
import type { Screen } from './screens';

/** A screen that isn't built yet: what it will show, and which wave builds it. */
export function Placeholder({ screen }: { screen: Screen }) {
  return (
    <div data-testid="placeholder">
      <p className="mb-3.5 text-[13px] text-t2">{screen.purpose}</p>
      <Card
        title={<span className="flex flex-wrap items-center gap-2">Coming in wave {screen.wave}</span>}
        sub="What this screen will show"
        action={<Pill tone="nu">Wave {screen.wave}</Pill>}
      >
        <CardBody>
          <ul className="flex flex-col">
            {screen.shows.map((line) => (
              <li
                key={line}
                className="flex gap-3 border-t border-hair py-2.5 text-[14px] text-t1 first:border-t-0 first:pt-0"
              >
                <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-t3" aria-hidden />
                {line}
              </li>
            ))}
          </ul>
          {screen.note && (
            <p className="mt-3 rounded-[10px] border border-hair bg-sf2 px-3 py-2.5 text-[13px] text-t2">
              {screen.note}
            </p>
          )}
        </CardBody>
      </Card>
      {screen.path === '/audit' && <ChainNow />}
    </div>
  );
}

/** The audit log is kept from day one: what the chain holds now. */
function ChainNow() {
  const verify = useQuery({
    queryKey: ['audit-verify'],
    queryFn: () => get<AuditVerify>('/api/audit/verify'),
    retry: quiet,
  });
  if (!verify.data) return null;
  const v = verify.data;
  return (
    <div
      className={`mt-3.5 flex items-center gap-3 rounded-[10px] border px-3 py-2.5 text-[13px] text-t1 ${v.ok ? 'border-gnbd bg-gndim' : 'border-rdbd bg-rddim'}`}
      data-testid="chain-now"
    >
      <ShieldCheck className="size-4 shrink-0" />
      <span>
        {v.ok ? (
          <>
            <b className="font-semibold">Already kept: chain intact.</b> {v.checked.toLocaleString('en-US')} records,
            each one’s hash matches the next. Checked just now.
          </>
        ) : (
          <>
            <b className="font-semibold">Chain broken at record {v.brokenAt}.</b> {v.reason}
          </>
        )}
      </span>
    </div>
  );
}
