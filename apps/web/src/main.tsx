import {lazy, StrictMode, Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter, Navigate, Route, Routes} from 'react-router-dom';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {Loader2} from 'lucide-react';
import {Toasts} from './components/ui';
import {ApiError} from './api';
import './styles/theme.css';
import './styles/motion.css';
import {installRevealObserver, installSpotlight} from './components/motion';

const Landing = lazy(() => import('./pages/Landing'));
const Console = lazy(() => import('./console/routes'));
// A 4xx (unknown request, bad input) will not succeed on retry; only transient failures are retried once.
const queryClient = new QueryClient({defaultOptions: {queries: {retry: (failures, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 1, refetchOnWindowFocus: true, staleTime: 2_000}}});
installRevealObserver();
installSpotlight();
const Loading = () => <div className="route-loading"><Loader2 className="spin" /></div>;

createRoot(document.getElementById('root')!).render(<StrictMode>
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/console/*" element={<Console />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
    <Toasts />
  </QueryClientProvider>
</StrictMode>);
