import AppCore from './AppCore';
import { ActivityFeedProvider } from './components/ActivityFeed';
import { AuthProvider } from './contexts/AuthContext';

export default function AppCoreWithProviders() {
  return (
    <AuthProvider>
      <ActivityFeedProvider>
        <AppCore />
      </ActivityFeedProvider>
    </AuthProvider>
  );
}
