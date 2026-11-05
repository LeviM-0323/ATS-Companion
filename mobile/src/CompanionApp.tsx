import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import { useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { parsePairingPayload, type PairingPayload } from './bridge/contracts';
import { useBridgeSession } from './bridge/useBridgeSession';

export type Tab = 'drive' | 'job' | 'truck' | 'setup';

export function isTab(value: unknown): value is Tab {
  return value === 'drive' || value === 'job' || value === 'truck' || value === 'setup';
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'drive', label: 'DRIVE' },
  { id: 'job', label: 'JOB' },
  { id: 'truck', label: 'TRUCK' },
  { id: 'setup', label: 'BRIDGE' },
];

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder} min`;
}

export function CompanionApp({ tab }: { tab: Tab }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wideLayout = width >= 760;
  const {
    bridgeUrl,
    setBridgeUrl,
    paired,
    manualCode,
    setManualCode,
    connection,
    connectionMessage,
    setConnectionMessage,
    snapshot,
    stale,
    staleAgeSeconds,
    pairing,
    pairWithCode,
    disconnect,
  } = useBridgeSession();
  const [scannerVisible, setScannerVisible] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const handledScan = useRef(false);
  const navigateTo = (nextTab: Tab) =>
    router.replace({ pathname: '/[tab]', params: { tab: nextTab } });

  const handleQrScanned = ({ data }: { data: string }) => {
    if (handledScan.current) return;
    handledScan.current = true;
    let payload: PairingPayload;
    try {
      payload = parsePairingPayload(data);
    } catch (error) {
      setConnectionMessage(error instanceof Error ? error.message : 'Could not read the pairing QR.');
      handledScan.current = false;
      return;
    }
    setBridgeUrl(payload.bridgeUrl);
    setScannerVisible(false);
    void pairWithCode(payload.bridgeUrl, payload.code).catch((error: unknown) => {
      setConnectionMessage(error instanceof Error ? error.message : 'Pairing failed.');
      handledScan.current = false;
    });
  };

  const openScanner = async () => {
    if (!cameraPermission?.granted) {
      const permission = await requestCameraPermission();
      if (!permission.granted) {
        setConnectionMessage('Camera access is needed to scan the setup QR. You can enter its code instead.');
        return;
      }
    }
    handledScan.current = false;
    setScannerVisible(true);
    setConnectionMessage('');
  };

  const connectManually = () => {
    void pairWithCode(bridgeUrl, manualCode).catch((error: unknown) => {
      setConnectionMessage(error instanceof Error ? error.message : 'Pairing failed.');
    });
  };

  const connectionLabel = stale
    ? 'STALE DATA'
    : connection === 'connected'
      ? snapshot?.mode === 'demo'
        ? 'DEMO DATA'
        : 'LIVE'
      : connection === 'connecting'
        ? 'CONNECTING'
        : connection === 'error'
          ? 'BRIDGE ERROR'
          : 'OFFLINE';

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <StatusBar style="light" />
      <View style={styles.topBar}>
        <View>
          <Text style={styles.brand}>ATS <Text style={styles.brandAccent}>COMPANION</Text></Text>
          <Text style={styles.eyebrow}>YOUR CAB, AT A GLANCE</Text>
        </View>
        <View style={styles.connectionPill}>
          <View
            style={[
              styles.connectionDot,
              connection === 'connected' && styles.connectedDot,
              stale && styles.staleDot,
              connection === 'error' && !stale && styles.errorDot,
            ]}
          />
          <Text style={styles.connectionLabel}>{connectionLabel}</Text>
        </View>
      </View>

      {stale && snapshot && (
        <View style={styles.staleNotice}>
          <Text style={styles.staleNoticeText}>
            STALE DATA · Last update{' '}
            {staleAgeSeconds}s ago
          </Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={[styles.content, wideLayout && styles.wideContent]}
        key={tab}
      >
        {tab === 'drive' && (
          <View style={wideLayout ? styles.twoColumns : undefined}>
            <View style={wideLayout ? styles.column : undefined}>
              <SectionHeading eyebrow="ON THE ROAD" title="Drive" />
              <Panel style={styles.statusPanel}>
                <Text style={styles.cardEyebrow}>GAME SESSION</Text>
                <Text style={styles.heroValue}>
                  {snapshot?.game.connected
                    ? snapshot.game.paused
                      ? 'Paused'
                      : 'In game'
                    : 'No game data'}
                </Text>
                <Text style={styles.mutedText}>
                  {snapshot?.game.connected
                    ? `${snapshot.truck.make} ${snapshot.truck.model}`
                    : 'Connect the Windows bridge to see your live truck and job.'}
                </Text>
                {!snapshot?.game.connected && (
                  <ActionButton label="SET UP BRIDGE" onPress={() => navigateTo('setup')} />
                )}
              </Panel>

              <SectionHeading eyebrow="CURRENT JOB" title={snapshot?.job?.cargo ?? 'No active job'} />
              <Panel>
                {snapshot?.job ? (
                  <>
                    <View style={styles.routeRow}>
                      <RouteStop label="FROM" place={snapshot.job.origin} />
                      <View style={styles.routeLine} />
                      <RouteStop label="TO" place={snapshot.job.destination} />
                    </View>
                    <View style={styles.divider} />
                    <View style={styles.inlineMetrics}>
                      <Metric label="REMAINING" value={`${snapshot.job.remainingMiles} mi`} />
                      <Metric
                        label="EST. DRIVE"
                        value={formatDuration(snapshot.job.estimatedTimeMinutes)}
                      />
                    </View>
                  </>
                ) : (
                  <Text style={styles.mutedText}>
                    Your cargo, route and remaining distance will appear here when a job is active.
                  </Text>
                )}
              </Panel>
            </View>

            <View style={wideLayout ? styles.column : undefined}>
              <SectionHeading eyebrow="VEHICLE TELEMETRY" title="Truck" />
              <Panel>
                <View style={styles.speedRow}>
                  <View>
                    <Text style={styles.cardEyebrow}>ROAD SPEED</Text>
                    <Text style={styles.speedValue}>
                      {snapshot?.game.connected ? snapshot.truck.speedMph : '--'}
                      <Text style={styles.speedUnit}> mph</Text>
                    </Text>
                  </View>
                  <View style={styles.gearBadge}>
                    <Text style={styles.cardEyebrow}>GEAR</Text>
                    <Text style={styles.gearValue}>
                      {snapshot?.game.connected ? snapshot.truck.gear : '--'}
                    </Text>
                  </View>
                </View>
                <View style={styles.divider} />
                <View style={styles.inlineMetrics}>
                  <Metric
                    label="FUEL"
                    value={
                      snapshot?.game.connected
                        ? `${snapshot.truck.fuelGallons.toFixed(1)} gal`
                        : '--'
                    }
                  />
                  <Metric
                    label="ENGINE"
                    value={
                      snapshot?.game.connected
                        ? `${snapshot.truck.engineRpm.toLocaleString()} rpm`
                        : '--'
                    }
                  />
                </View>
              </Panel>

              {snapshot?.mode === 'demo' && (
                <View style={styles.demoNotice}>
                  <Text style={styles.demoNoticeText}>
                    DEMO PREVIEW · These sample readings are not from your game.
                  </Text>
                </View>
              )}
            </View>
          </View>
        )}

        {tab === 'job' && (
          <>
            <SectionHeading eyebrow="CONTRACT" title="Current job" />
            <Panel>
              {snapshot?.job ? (
                <>
                  <Text style={styles.cardEyebrow}>CARGO</Text>
                  <Text style={styles.cardTitle}>{snapshot.job.cargo}</Text>
                  <View style={styles.divider} />
                  <View style={styles.routeRow}>
                    <RouteStop label="PICKUP" place={snapshot.job.origin} />
                    <View style={styles.routeLine} />
                    <RouteStop label="DELIVERY" place={snapshot.job.destination} />
                  </View>
                  <View style={styles.divider} />
                  <View style={styles.inlineMetrics}>
                    <Metric label="DISTANCE LEFT" value={`${snapshot.job.remainingMiles} mi`} />
                    <Metric
                      label="EST. DRIVE"
                      value={formatDuration(snapshot.job.estimatedTimeMinutes)}
                    />
                  </View>
                </>
              ) : (
                <EmptyState
                  title="No active job"
                  message="Start a delivery in ATS and connect the bridge to see its route and progress."
                  onPress={() => navigateTo('setup')}
                />
              )}
            </Panel>
          </>
        )}

        {tab === 'truck' && (
          <>
            <SectionHeading eyebrow="VEHICLE TELEMETRY" title="Truck" />
            <Panel>
              {snapshot?.game.connected ? (
                <>
                  <Text style={styles.cardEyebrow}>CURRENT VEHICLE</Text>
                  <Text style={styles.cardTitle}>
                    {snapshot.truck.make} {snapshot.truck.model}
                  </Text>
                  <View style={styles.divider} />
                  <View style={styles.metricGrid}>
                    <Metric
                      label="SPEED"
                      style={styles.gridMetric}
                      value={`${snapshot.truck.speedMph} mph`}
                    />
                    <Metric label="GEAR" style={styles.gridMetric} value={snapshot.truck.gear} />
                    <Metric
                      label="FUEL"
                      style={styles.gridMetric}
                      value={`${snapshot.truck.fuelGallons.toFixed(1)} / ${snapshot.truck.fuelCapacityGallons} gal`}
                    />
                    <Metric
                      label="ENGINE"
                      style={styles.gridMetric}
                      value={`${snapshot.truck.engineRpm} rpm`}
                    />
                    <Metric
                      label="ODOMETER"
                      style={styles.gridMetric}
                      value={`${snapshot.truck.odometerMiles.toLocaleString()} mi`}
                    />
                  </View>
                </>
              ) : (
                <EmptyState
                  title="Truck data unavailable"
                  message="Truck details will show up here when the bridge is connected to an ATS game session."
                  onPress={() => navigateTo('setup')}
                />
              )}
            </Panel>
          </>
        )}

        {tab === 'setup' && (
          <>
            <SectionHeading eyebrow="LOCAL CONNECTION" title="Windows bridge" />
            <Panel>
              {paired ? (
                <>
                  <Text style={styles.cardTitle}>Paired to your PC</Text>
                  <Text style={styles.mutedText}>{bridgeUrl}</Text>
                  {connection === 'connected' && !stale && (
                    <Text style={styles.connectedMessage}>This device reconnects automatically.</Text>
                  )}
                  <ActionButton label="REVOKE & FORGET THIS DEVICE" onPress={disconnect} secondary />
                </>
              ) : (
                <>
                  <Text style={styles.cardTitle}>Connect to your PC</Text>
                  <Text style={[styles.mutedText, styles.setupCopy]}>
                    Open the bridge setup page on your Windows PC. Scan its QR code or enter the
                    short code below. Pairing is remembered securely on this device.
                  </Text>
                  <ActionButton
                    label={pairing ? 'PAIRING…' : 'SCAN SETUP QR'}
                    onPress={() => {
                      void openScanner().catch((error: unknown) => {
                        setConnectionMessage(
                          error instanceof Error ? error.message : 'Camera permission is unavailable.',
                        );
                      });
                    }}
                  />
                  <Text style={styles.inputLabel}>OR ENTER THE SHORT CODE</Text>
                  <TextInput
                    accessibilityLabel="Bridge address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    onChangeText={setBridgeUrl}
                    placeholder="http://192.168.1.25:3210"
                    placeholderTextColor={colors.subtle}
                    style={styles.input}
                    value={bridgeUrl}
                  />
                  <TextInput
                    accessibilityLabel="One-time pairing code"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={8}
                    onChangeText={setManualCode}
                    placeholder="8-character code under the QR"
                    placeholderTextColor={colors.subtle}
                    style={[styles.input, styles.codeInput]}
                    value={manualCode}
                  />
                  <ActionButton
                    label={pairing ? 'PAIRING…' : 'PAIR DEVICE'}
                    onPress={connectManually}
                  />
                </>
              )}
              {connectionMessage !== '' && (
                <Text accessibilityRole="alert" style={styles.errorMessage}>
                  {connectionMessage}
                </Text>
              )}
            </Panel>
            <Panel style={styles.instructionsPanel}>
              <Text style={styles.cardEyebrow}>FIRST TIME?</Text>
              <Text style={styles.instructionText}>
                Start the bridge on the Windows PC. Its local setup page opens automatically and
                displays a one-time QR code. Install the SCS telemetry plugin to read live ATS data.
              </Text>
              <Text style={styles.command}>
                cd windows-bridge{'\n'}npm start{'\n'}npm run setup:plugin
              </Text>
            </Panel>
            <Text style={styles.networkNote}>
              Keep the bridge on a trusted private network. Do not expose its port to the internet.
            </Text>
          </>
        )}
      </ScrollView>

      <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {TABS.map((item) => (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === item.id }}
            key={item.id}
            onPress={() => navigateTo(item.id)}
            style={styles.tab}
          >
            <Text style={[styles.tabLabel, tab === item.id && styles.activeTabLabel]}>
              {item.label}
            </Text>
            <View style={[styles.tabIndicator, tab === item.id && styles.activeTabIndicator]} />
          </Pressable>
        ))}
      </View>
      <Modal
        animationType="slide"
        onRequestClose={() => {
          setScannerVisible(false);
          handledScan.current = false;
        }}
        visible={scannerVisible}
      >
        <View style={styles.scannerScreen}>
          <CameraView
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            facing="back"
            onBarcodeScanned={handleQrScanned}
            style={styles.camera}
          />
          <View style={styles.scannerOverlay}>
            <Text style={styles.scannerTitle}>Scan bridge QR</Text>
            <Text style={styles.scannerDescription}>Keep the QR inside the camera frame.</Text>
            <View style={styles.scannerFrame} />
            <ActionButton
              label="CANCEL"
              onPress={() => {
                setScannerVisible(false);
                handledScan.current = false;
              }}
              secondary
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function Panel({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.panel, style]}>{children}</View>;
}

function RouteStop({ label, place }: { label: string; place: string }) {
  return (
    <View style={styles.routeStop}>
      <Text style={styles.cardEyebrow}>{label}</Text>
      <Text style={styles.routePlace}>{place}</Text>
    </View>
  );
}

function Metric({
  label,
  value,
  style,
}: {
  label: string;
  value: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.metric, style]}>
      <Text style={styles.cardEyebrow}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  secondary = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.actionButton, secondary && styles.secondaryButton]}
    >
      <Text style={[styles.actionButtonText, secondary && styles.secondaryButtonText]}>{label}</Text>
    </Pressable>
  );
}

function EmptyState({
  title,
  message,
  onPress,
}: {
  title: string;
  message: string;
  onPress: () => void;
}) {
  return (
    <View>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.mutedText}>{message}</Text>
      <ActionButton label="SET UP BRIDGE" onPress={onPress} />
    </View>
  );
}

const colors = {
  background: '#0B1015',
  panel: '#151D25',
  border: '#25313B',
  text: '#F3F5F6',
  muted: '#9BA8B2',
  subtle: '#63717C',
  accent: '#F3A444',
  green: '#70D6A0',
  red: '#FF7C70',
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  topBar: {
    minHeight: 84,
    paddingHorizontal: 22,
    paddingTop: 8,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: { color: colors.text, fontSize: 17, fontWeight: '900', letterSpacing: 1.4 },
  brandAccent: { color: colors.accent },
  eyebrow: { color: colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  connectionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 11,
  },
  connectionDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.subtle },
  connectedDot: { backgroundColor: colors.green },
  errorDot: { backgroundColor: colors.red },
  staleDot: { backgroundColor: colors.accent },
  connectionLabel: { color: colors.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  staleNotice: {
    backgroundColor: '#2A2116',
    borderBottomWidth: 1,
    borderBottomColor: '#76572E',
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  staleNoticeText: { color: '#F3C887', fontSize: 11, fontWeight: '700' },
  content: { padding: 20, paddingBottom: 30, gap: 2 },
  wideContent: { alignSelf: 'center', width: '100%', maxWidth: 1120, paddingHorizontal: 32 },
  twoColumns: { flexDirection: 'row', gap: 20 },
  column: { flex: 1 },
  sectionHeading: { marginTop: 18, marginBottom: 10 },
  sectionTitle: { color: colors.text, fontSize: 23, fontWeight: '800', marginTop: 3 },
  panel: {
    backgroundColor: colors.panel,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 18,
    marginBottom: 12,
  },
  statusPanel: { minHeight: 176, justifyContent: 'center' },
  cardEyebrow: { color: colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 1.2 },
  heroValue: { color: colors.text, fontSize: 28, fontWeight: '800', marginTop: 8 },
  mutedText: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 7 },
  actionButton: {
    minHeight: 46,
    backgroundColor: colors.accent,
    borderRadius: 11,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 18,
  },
  actionButtonText: { color: '#17120B', fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  secondaryButton: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  secondaryButtonText: { color: colors.text },
  routeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  routeStop: { flex: 1 },
  routeLine: { width: 24, height: 2, backgroundColor: colors.accent },
  routePlace: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: 6 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 16 },
  inlineMetrics: { flexDirection: 'row', gap: 20 },
  metric: { flex: 1 },
  metricValue: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 6 },
  speedRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  speedValue: { color: colors.text, fontSize: 43, fontWeight: '800', marginTop: 3 },
  speedUnit: { color: colors.muted, fontSize: 15, fontWeight: '600' },
  gearBadge: {
    minWidth: 70,
    height: 70,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  gearValue: { color: colors.accent, fontSize: 23, fontWeight: '900', marginTop: 2 },
  demoNotice: {
    borderColor: '#76572E',
    borderWidth: 1,
    borderRadius: 10,
    backgroundColor: '#2A2116',
    padding: 12,
    marginTop: 4,
  },
  demoNoticeText: { color: '#F3C887', fontSize: 11, fontWeight: '700', lineHeight: 16 },
  cardTitle: { color: colors.text, fontSize: 20, fontWeight: '800', marginTop: 5 },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 22, columnGap: 18 },
  gridMetric: { flex: 0, width: '46%' },
  setupCopy: { marginBottom: 20 },
  inputLabel: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.1,
    marginTop: 14,
    marginBottom: 7,
  },
  input: {
    minHeight: 48,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    color: colors.text,
    fontSize: 14,
  },
  codeInput: { marginTop: 8, letterSpacing: 3, fontWeight: '800', textAlign: 'center' },
  connectedMessage: { color: colors.green, fontSize: 13, marginTop: 10 },
  errorMessage: { color: colors.red, fontSize: 13, lineHeight: 19, marginTop: 12 },
  instructionsPanel: { marginTop: 4 },
  instructionText: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 8 },
  command: {
    color: colors.accent,
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 19,
    marginTop: 12,
    backgroundColor: colors.background,
    borderRadius: 8,
    padding: 12,
  },
  networkNote: { color: colors.subtle, fontSize: 11, lineHeight: 16, marginTop: 4, marginBottom: 12 },
  tabBar: {
    minHeight: 62,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingHorizontal: 8,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  tabLabel: { color: colors.subtle, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  activeTabLabel: { color: colors.accent },
  tabIndicator: { height: 2, width: 24, backgroundColor: 'transparent' },
  activeTabIndicator: { backgroundColor: colors.accent },
  scannerScreen: { flex: 1, backgroundColor: colors.background },
  camera: { ...StyleSheet.absoluteFill },
  scannerOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingTop: 72,
    paddingBottom: 36,
    backgroundColor: 'rgba(11, 16, 21, 0.38)',
  },
  scannerTitle: { color: colors.text, fontSize: 23, fontWeight: '800' },
  scannerDescription: { color: colors.text, fontSize: 14, marginTop: -32 },
  scannerFrame: {
    width: 250,
    height: 250,
    borderWidth: 3,
    borderColor: colors.accent,
    borderRadius: 18,
  },
});
