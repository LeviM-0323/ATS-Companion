import { Redirect, useLocalSearchParams } from 'expo-router';
import { CompanionApp, isTab } from '../CompanionApp';

export default function TabRoute() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  if (!isTab(tab)) {
    return <Redirect href={{ pathname: '/[tab]', params: { tab: 'drive' } }} />;
  }
  return <CompanionApp tab={tab} />;
}
