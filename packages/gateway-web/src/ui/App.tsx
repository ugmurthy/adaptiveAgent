import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { DashboardPage } from './routes/DashboardPage';
import { ComposerPage } from './routes/ComposerPage';
import { RunPage } from './routes/RunPage';

type AppRoute = 'composer' | 'monitor' | 'run';

export function App(): ReactElement {
  const [route, setRoute] = useState(readRoute());

  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  if (route === 'monitor') {
    return <DashboardPage />;
  }

  if (route === 'run') {
    return <RunPage />;
  }

  return <ComposerPage />;
}

function readRoute(): AppRoute {
  if (window.location.pathname === '/monitor') {
    return 'monitor';
  }

  if (window.location.pathname === '/run') {
    return 'run';
  }

  return 'composer';
}
