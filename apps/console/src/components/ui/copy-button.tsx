import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { copyText } from '@/lib/copy';
import { Button } from './button';

/** "Copy for Excel": puts tab-separated rows on the clipboard. */
export function CopyButton({ tsv }: { tsv: () => string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  return (
    <Button
      size="sm"
      onClick={async () => {
        setState((await copyText(tsv())) ? 'done' : 'failed');
        setTimeout(() => setState('idle'), 2000);
      }}
    >
      {state === 'done' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Copy blocked' : 'Copy for Excel'}
    </Button>
  );
}
