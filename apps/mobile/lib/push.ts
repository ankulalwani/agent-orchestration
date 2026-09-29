import { Platform } from 'react-native';
import * as Device from 'expo-device';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { post } from './api';

/**
 * Why push notifications can't work in this build, or null when they can. Expo Go on Android has no
 * remote push since SDK 53 (a development or store build is needed); loading expo-notifications there
 * reports an error, so the module is only loaded when push can work.
 */
export function pushUnavailableReason(): string | null {
  if (Platform.OS === 'android' && Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    return 'Push notifications need a development or store build of the app; Expo Go on Android does not support them.';
  }
  if (Platform.OS === 'web') return 'Push notifications are not available on the web';
  return null;
}

type NotificationsModule = typeof import('expo-notifications');
let loaded: Promise<NotificationsModule> | null = null;
function notifications(): Promise<NotificationsModule> {
  loaded ??= import('expo-notifications').then((N) => {
    // Show notifications while the app is in the foreground (SDK 57 handler fields).
    N.setNotificationHandler({
      handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: true, shouldShowBanner: true, shouldShowList: true }),
    });
    return N;
  });
  return loaded;
}

/** Opens tasks from notification taps. Returns a cleanup function; does nothing where push can't work. */
export function listenForNotificationTaps(openTask: (taskId: string) => void): () => void {
  if (pushUnavailableReason()) return () => undefined;
  let remove: (() => void) | null = null;
  let stopped = false;
  void notifications().then((N) => {
    if (stopped) return;
    const sub = N.addNotificationResponseReceivedListener((r) => {
      const taskId = r.notification.request.content.data?.taskId;
      if (typeof taskId === 'string') openTask(taskId);
    });
    remove = () => sub.remove();
  });
  return () => {
    stopped = true;
    remove?.();
  };
}

/**
 * Registers this device for push notifications (spec §53: task completed/failed, worker offline,
 * provider limit, approval/recovery required). Requires a physical device, a development or store build
 * on Android, and an EAS project id; the control plane only sends pushes when EXPO_PUSH_ENABLED=true
 * (outbound calls are opt-in, spec §127).
 */
export async function registerForPush(): Promise<{ ok: boolean; reason?: string }> {
  const unavailable = pushUnavailableReason();
  if (unavailable) return { ok: false, reason: unavailable };
  if (!Device.isDevice) return { ok: false, reason: 'Push notifications need a physical device' };
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string | null } } | undefined)?.eas?.projectId;
  if (!projectId) return { ok: false, reason: 'This build has no EAS project id configured for push notifications' };
  const N = await notifications();
  if (Platform.OS === 'android') {
    // Must exist before requesting a token on Android 13+.
    await N.setNotificationChannelAsync('default', { name: 'Task updates', importance: N.AndroidImportance.DEFAULT });
  }
  const perm = await N.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } });
  const granted = perm.granted || perm.ios?.status === N.IosAuthorizationStatus.PROVISIONAL;
  if (!granted) return { ok: false, reason: 'Permission not granted' };
  const token = await N.getExpoPushTokenAsync({ projectId });
  await post('/me/push-tokens', { token: token.data, platform: Platform.OS });
  return { ok: true };
}
