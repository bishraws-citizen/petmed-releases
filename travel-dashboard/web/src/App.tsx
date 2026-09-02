import { NavLink, Route, Routes, useLocation } from 'react-router-dom';

import { useResource } from './lib/api';
import type { Overview } from './lib/types';
import { useTheme } from './components/ui';
import { DashboardPage } from './pages/Dashboard';
import { RequestsPage } from './pages/Requests';
import { BookingsPage } from './pages/Bookings';
import { BookingDetailPage } from './pages/BookingDetail';
import { PaymentsPage } from './pages/Payments';
import { ClientsPage } from './pages/Clients';

const PAGES = [
  { to: '/', label: 'Dashboard', title: 'Dashboard', sub: 'How the agency is trading right now' },
  { to: '/requests', label: 'Requests', title: 'Travel requests', sub: 'Enquiries from first contact to a won booking' },
  { to: '/bookings', label: 'Bookings', title: 'Bookings', sub: 'Confirmed travel, suppliers and margin' },
  { to: '/payments', label: 'Payments', title: 'Payments', sub: 'Deposits, balances and refunds' },
  { to: '/clients', label: 'Clients', title: 'Clients', sub: 'Everyone the agency books for' },
] as const;

const THEME_LABEL = { system: 'System', light: 'Light', dark: 'Dark' } as const;

export function App() {
  const { pathname } = useLocation();
  const { theme, cycle } = useTheme();
  // Nav badges track work waiting on someone, so they refresh with the route.
  const { data: overview } = useResource<Overview>(`/overview?months=6&at=${pathname}`);

  const counts: Record<string, number | undefined> = {
    '/requests': overview?.kpis.open_requests,
    '/payments': overview?.kpis.overdue_count,
    '/bookings': overview?.kpis.pending_count,
  };

  const current =
    PAGES.find((page) => (page.to === '/' ? pathname === '/' : pathname.startsWith(page.to))) ?? PAGES[0];

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden>V</span>
          <span>
            <div className="brand-name">Voyager</div>
            <div className="brand-sub">Travel agency ops</div>
          </span>
        </div>

        <span className="nav-label">Workspace</span>
        {PAGES.map((page) => (
          <NavLink
            key={page.to}
            to={page.to}
            end={page.to === '/'}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            {page.label}
            {counts[page.to] ? <span className="count">{counts[page.to]}</span> : null}
          </NavLink>
        ))}

        <div className="sidebar-footer">
          <button type="button" className="btn btn-ghost btn-sm" onClick={cycle} style={{ width: '100%' }}>
            Theme: {THEME_LABEL[theme]}
          </button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <div className="topbar-titles">
            <h1>{current.title}</h1>
            <p className="topbar-sub">{current.sub}</p>
          </div>
        </header>

        <main className="content">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/requests" element={<RequestsPage />} />
            <Route path="/bookings" element={<BookingsPage />} />
            <Route path="/bookings/:id" element={<BookingDetailPage />} />
            <Route path="/payments" element={<PaymentsPage />} />
            <Route path="/clients" element={<ClientsPage />} />
            <Route path="*" element={<p>That page does not exist.</p>} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
