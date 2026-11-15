import { Navigate, type RouteObject } from 'react-router';
import { AppShell } from './components/shell/app-shell';
import { NotFoundPage } from './routes/not-found';
import { Placeholder } from './routes/placeholder';
import { ApprovalsPage } from './routes/approvals';
import { AuditPage } from './routes/audit';
import { RequestPage } from './routes/request';
import { BudgetsPage } from './routes/budgets';
import { ExplorePage } from './routes/explore';
import { OverviewPage } from './routes/overview';
import { ProfilePage } from './routes/profile';
import { RulesPage } from './routes/rules';
import { AgentsPage } from './routes/agents';
import { AnomaliesPage } from './routes/anomalies';
import { AccessReviewPage } from './routes/access-review';
import { ContractsPage } from './routes/contracts';
import { ReconciliationPage } from './routes/reconciliation';
import { SCREENS } from './routes/screens';
import { AccrualsPage, ClosePage, DatarailsPage, NotesPage, PackagePage } from './routes/month-end';

/** Built screens; the rest are placeholders that name their wave. */
const BUILT = new Set([
  '/overview',
  '/explore',
  '/budgets',
  '/reconciliation',
  '/anomalies',
  '/agents',
  '/contracts',
  '/approvals',
  '/audit',
  '/rules',
  '/access-review',
  '/close',
]);

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      { path: 'overview', element: <OverviewPage /> },
      { path: 'explore', element: <ExplorePage /> },
      { path: 'budgets', element: <BudgetsPage /> },
      { path: 'reconciliation', element: <ReconciliationPage /> },
      { path: 'anomalies', element: <AnomaliesPage /> },
      { path: 'agents', element: <AgentsPage /> },
      { path: 'contracts', element: <ContractsPage /> },
      { path: 'access-review', element: <AccessReviewPage /> },
      { path: 'approvals', element: <ApprovalsPage /> },
      { path: 'approvals/:id', element: <RequestPage /> },
      // Webhooks (request.step_pending) link to /requests/:id.
      { path: 'requests/:id', element: <RequestPage /> },
      { path: 'audit', element: <AuditPage /> },
      { path: 'profile', element: <ProfilePage /> },
      { path: 'close', element: <ClosePage /> },
      { path: 'close/accruals', element: <AccrualsPage /> },
      { path: 'close/notes', element: <NotesPage /> },
      { path: 'close/datarails', element: <DatarailsPage /> },
      { path: 'close/package', element: <PackagePage /> },
      ...SCREENS.filter((s) => !BUILT.has(s.path)).map((s) => ({
        path: s.path.slice(1),
        element: <Placeholder screen={s} />,
      })),
      { path: 'rules', element: <RulesPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
