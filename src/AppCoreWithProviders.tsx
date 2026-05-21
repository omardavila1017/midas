import AppCore from './AppCore';
import { ActivityFeedProvider } from './components/ActivityFeed';

export default function AppCoreWithProviders() {
  return (
    <ActivityFeedProvider>
      <AppCore />
    </ActivityFeedProvider>
  );
}
