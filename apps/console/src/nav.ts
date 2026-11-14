import {
  Activity,
  Bot,
  CalendarCheck,
  ChartColumn,
  CircleCheck,
  FileText,
  LayoutDashboard,
  Receipt,
  type LucideIcon,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** On the phone's bottom bar; the rest sit under More. */
  bar?: boolean;
}

/** docs/ui.md, "Navigation": the sidebar groups on desktop; on a phone the `bar` items and More. */
export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Money',
    items: [
      { href: '/overview', label: 'Overview', icon: LayoutDashboard, bar: true },
      { href: '/explore', label: 'Explore', icon: ChartColumn, bar: true },
      { href: '/budgets', label: 'Budgets', icon: Wallet },
      { href: '/reconciliation', label: 'Reconciliation', icon: Receipt },
    ],
  },
  {
    label: 'Control',
    items: [
      { href: '/approvals', label: 'Approvals', icon: CircleCheck, bar: true },
      { href: '/anomalies', label: 'Anomalies', icon: Activity },
      { href: '/contracts', label: 'Contracts', icon: FileText },
    ],
  },
  { label: 'Value', items: [{ href: '/agents', label: 'Agents', icon: Bot }] },
  { label: 'Close', items: [{ href: '/close', label: 'Month-end', icon: CalendarCheck }] },
  {
    label: 'Setup',
    items: [
      { href: '/rules', label: 'Rates and rules', icon: SlidersHorizontal },
      { href: '/audit', label: 'Audit log', icon: ShieldCheck },
    ],
  },
];

export const ALL_PAGES: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** The page a path belongs to (`/approvals/r1` is Approvals). */
export const pageOf = (pathname: string): NavItem | undefined =>
  ALL_PAGES.find((p) => pathname === p.href || pathname.startsWith(`${p.href}/`));
