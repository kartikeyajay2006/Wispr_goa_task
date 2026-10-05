import {Route, Routes} from 'react-router-dom';
import ConsoleLayout from './ConsoleLayout';
import RequestDetail from './RequestDetail';
import {Approvals, AuditLog, Customers, NewRequestPage, Overview, Policies, Requests, Systems} from './pages';
import '../styles/console.css';

export default function ConsoleRoutes() {
  return <Routes>
    <Route element={<ConsoleLayout />}>
      <Route index element={<Overview />} />
      <Route path="requests" element={<Requests />} />
      <Route path="requests/new" element={<NewRequestPage />} />
      <Route path="requests/:id" element={<RequestDetail />} />
      <Route path="approvals" element={<Approvals />} />
      <Route path="customers" element={<Customers />} />
      <Route path="systems" element={<Systems />} />
      <Route path="policies" element={<Policies />} />
      <Route path="audit" element={<AuditLog />} />
    </Route>
  </Routes>;
}
