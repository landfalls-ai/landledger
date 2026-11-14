import { Navigate, type RouteObject } from 'react-router';
import { AppShell } from './components/shell/app-shell';
import { NotFoundPage } from './routes/not-found';
import { Placeholder } from './routes/placeholder';
import { BudgetsPage } from './routes/budgets';
import { ExplorePage } from './routes/explore';
import { OverviewPage } from './routes/overview';
import { RulesPage } from './routes/rules';
import { SCREENS } from './routes/screens';

const approvals = SCREENS.find((s) => s.path === '/approvals')!;

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      { path: 'overview', element: <OverviewPage /> },
      { path: 'explore', element: <ExplorePage /> },
      { path: 'budgets', element: <BudgetsPage /> },
      ...SCREENS.filter((s) => s.wave > 1).map((s) => ({ path: s.path.slice(1), element: <Placeholder screen={s} /> })),
      { path: 'approvals/:id', element: <Placeholder screen={approvals} /> },
      { path: 'rules', element: <RulesPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
