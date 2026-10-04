import { useEffect } from 'react';
import { ToastProvider } from './primitives';
import { navigate, usePrefs, useRoute, useTheme } from './hooks';
import { Sidebar } from './Sidebar';
import { OverviewPage } from './pages/Overview';
import { ChannelsPage } from './pages/Channels';
import { AnalyticsPage } from './pages/Analytics';
import { CleanupPage } from './pages/Cleanup';
import { UnsubscribedPage } from './pages/Unsubscribed';
import { BellAuditPage } from './pages/BellAudit';
import { SettingsPage } from './pages/Settings';
import { WelcomePage } from './pages/Welcome';
import { UpdateBanner } from './UpdateBanner';
import { PlaylistsPage } from './pages/Playlists';
import { PlaylistDetailPage } from './pages/PlaylistDetail';
import { WatchLaterPage } from './pages/WatchLater';
import { CategoriesPage } from './pages/Categories';
import { DeletedItemsPage } from './pages/DeletedItems';

export function App() {
  const prefs = usePrefs();
  const { path } = useRoute();
  useTheme(prefs.theme);

  useEffect(() => {
    if (!window.location.hash) navigate('/overview');
  }, []);

  if (path === '/welcome') {
    return (
      <ToastProvider>
        <WelcomePage />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <div className="flex h-full min-h-0">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto" id="main">
          <UpdateBanner />
          {path === '/overview' && <OverviewPage />}
          {path === '/channels' && <ChannelsPage />}
          {path === '/analytics' && <AnalyticsPage />}
          {path === '/cleanup' && <CleanupPage />}
          {path === '/unsubscribed' && <UnsubscribedPage />}
          {path === '/bells' && <BellAuditPage />}
          {path === '/settings' && <SettingsPage />}
          {path === '/playlists' && <PlaylistsPage />}
          {path === '/playlist' && <PlaylistDetailPage />}
          {path === '/watch-later' && <WatchLaterPage />}
          {path === '/categories' && <CategoriesPage />}
          {path === '/deleted' && <DeletedItemsPage />}
        </main>
      </div>
    </ToastProvider>
  );
}
