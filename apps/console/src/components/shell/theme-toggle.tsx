import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';

type Theme = 'system' | 'light' | 'dark';
const KEY = 'landledger-theme';

function current(): Theme {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' || theme === 'dark' ? theme : 'system';
}

function apply(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
}

const OPTIONS: Array<{ value: Theme; icon: typeof Sun; label: string }> = [
  { value: 'system', icon: Monitor, label: 'System' },
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
];

/** System, light or dark (the prototype's segmented control); index.html applies the saved choice before paint. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(current);
  return (
    <div
      className="inline-flex w-fit gap-0.5 rounded-[9px] border border-bd p-0.5"
      role="radiogroup"
      aria-label="Theme"
    >
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={`${label} theme`}
          title={label}
          onClick={() => {
            setTheme(value);
            apply(value);
          }}
          className={cn(
            'grid h-7 min-w-[30px] place-items-center rounded-md px-2 text-t3 transition-colors hover:text-t1',
            theme === value && 'bg-acdim font-semibold text-t1',
          )}
        >
          <Icon className="size-[15px]" strokeWidth={1.75} />
        </button>
      ))}
    </div>
  );
}
