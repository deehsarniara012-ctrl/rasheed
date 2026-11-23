import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  User,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { Classification, CommandDecisionReport, GeoDetectionPin } from '../types/vision';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Validate connection to Firestore on application boot
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return cleaned || `id_${Date.now()}`;
}

function clampStr(val: string, maxLen: number, fallback = 'Untitled'): string {
  const trimmed = val.trim();
  if (!trimmed) return fallback.slice(0, maxLen);
  return trimmed.slice(0, maxLen);
}

export function subscribeAuthState(cb: (user: User | null) => void) {
  return onAuthStateChanged(auth, cb);
}

export async function signInWithGoogle(): Promise<User> {
  const credential = await signInWithPopup(auth, googleProvider);
  await ensureUserWorkspace(credential.user);
  return credential.user;
}

export async function signOutGoogle(): Promise<void> {
  await signOut(auth);
}

export async function ensureUserWorkspace(user: User): Promise<void> {
  if (!user.emailVerified) {
    throw new Error('Verified Google account email is required for cloud workspace sync.');
  }
  const uid = sanitizeId(user.uid);
  const rootPath = `users/${uid}`;
  const rootRef = doc(db, 'users', uid);

  try {
    const rootSnap = await getDoc(rootRef);
    const displayName = clampStr(user.displayName || 'GAZVA Operator', 120, 'GAZVA Operator');
    if (!rootSnap.exists()) {
      await setDoc(rootRef, {
        uid,
        displayName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(rootRef, {
        displayName,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, rootPath);
  }

  const privatePath = `users/${uid}/private/info`;
  const privateRef = doc(db, 'users', uid, 'private', 'info');
  try {
    const privSnap = await getDoc(privateRef);
    const email = clampStr(user.email || 'unknown@example.com', 254);
    const photoURL = (user.photoURL || '').slice(0, 512);
    if (!privSnap.exists()) {
      await setDoc(privateRef, {
        uid,
        email,
        ...(photoURL ? { photoURL } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(privateRef, {
        email,
        ...(photoURL ? { photoURL } : { photoURL: '' }),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, privatePath);
  }
}

export interface CloudMissionItem {
  id: string;
  ownerId: string;
  kind: 'report' | 'rules' | 'ai_session';
  title: string;
  summary: string;
  riskLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'INFO';
  modelUsed?: string;
  createdAtMs: number;
}

export async function saveMissionReportToFirestore(
  userId: string,
  report: CommandDecisionReport
): Promise<void> {
  const uid = sanitizeId(userId);
  const missionId = sanitizeId(report.id || `rep-${Date.now()}`);
  const docPath = `users/${uid}/missions/${missionId}`;

  try {
    await setDoc(doc(db, 'users', uid, 'missions', missionId), {
      ownerId: uid,
      kind: 'report',
      title: clampStr(`C2 Fusion Brief (${report.overallRiskLevel})`, 160),
      summary: clampStr(
        `${report.executiveBrief}\n\nForecast: ${report.predictiveForecast}\nNetwork: ${report.cyberNetworkHealth}`,
        4000
      ),
      riskLevel: report.overallRiskLevel,
      modelUsed: 'gemini-4-hydrogen',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, docPath);
  }
}

export async function saveAiSessionLogToFirestore(
  userId: string,
  title: string,
  summary: string,
  modelUsed: string
): Promise<void> {
  const uid = sanitizeId(userId);
  const missionId = sanitizeId(`ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const docPath = `users/${uid}/missions/${missionId}`;

  try {
    await setDoc(doc(db, 'users', uid, 'missions', missionId), {
      ownerId: uid,
      kind: 'ai_session',
      title: clampStr(title, 160),
      summary: clampStr(summary, 4000),
      riskLevel: 'INFO',
      modelUsed: clampStr(modelUsed, 80, 'gemini-4-hydrogen'),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, docPath);
  }
}

export function subscribeUserMissions(
  userId: string,
  onData: (missions: CloudMissionItem[]) => void
) {
  const uid = sanitizeId(userId);
  const colPath = `users/${uid}/missions`;
  const q = query(
    collection(db, 'users', uid, 'missions'),
    where('ownerId', '==', uid),
    orderBy('createdAt', 'desc'),
    limit(20)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const items: CloudMissionItem[] = snapshot.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        const ts = data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : Date.now();
        return {
          id: d.id,
          ownerId: String(data.ownerId || uid),
          kind:
            data.kind === 'report' || data.kind === 'rules' || data.kind === 'ai_session'
              ? data.kind
              : 'report',
          title: String(data.title || 'Mission Log'),
          summary: String(data.summary || ''),
          riskLevel:
            data.riskLevel === 'LOW' ||
            data.riskLevel === 'MODERATE' ||
            data.riskLevel === 'HIGH'
              ? data.riskLevel
              : 'INFO',
          modelUsed: typeof data.modelUsed === 'string' ? data.modelUsed : undefined,
          createdAtMs: ts,
        };
      });
      onData(items);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, colPath);
    }
  );
}

export async function saveWaypointToFirestore(
  userId: string,
  pin: GeoDetectionPin
): Promise<void> {
  const uid = sanitizeId(userId);
  const wpId = sanitizeId(pin.id || `wp-${Date.now()}`);
  const docPath = `users/${uid}/waypoints/${wpId}`;

  const payload: Record<string, unknown> = {
    ownerId: uid,
    label: clampStr(pin.label, 120, 'Waypoint'),
    classification: pin.classification,
    score: Math.max(0, Math.min(1, Number.isFinite(pin.score) ? pin.score : 1)),
    gridX: Math.max(0, Math.min(100, Number.isFinite(pin.gridX) ? pin.gridX : 50)),
    gridY: Math.max(0, Math.min(100, Number.isFinite(pin.gridY) ? pin.gridY : 50)),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (
    typeof pin.latitude === 'number' &&
    Number.isFinite(pin.latitude) &&
    pin.latitude >= -90 &&
    pin.latitude <= 90
  ) {
    payload.latitude = pin.latitude;
  }
  if (
    typeof pin.longitude === 'number' &&
    Number.isFinite(pin.longitude) &&
    pin.longitude >= -180 &&
    pin.longitude <= 180
  ) {
    payload.longitude = pin.longitude;
  }

  try {
    await setDoc(doc(db, 'users', uid, 'waypoints', wpId), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, docPath);
  }
}

export function subscribeUserWaypoints(
  userId: string,
  onData: (pins: GeoDetectionPin[]) => void
) {
  const uid = sanitizeId(userId);
  const colPath = `users/${uid}/waypoints`;
  const q = query(
    collection(db, 'users', uid, 'waypoints'),
    where('ownerId', '==', uid),
    orderBy('createdAt', 'desc'),
    limit(24)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const pins: GeoDetectionPin[] = snapshot.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        const ts = data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : Date.now();
        const cls: Classification =
          data.classification === 'positive' || data.classification === 'negative'
            ? data.classification
            : 'neutral';
        return {
          id: d.id,
          label: String(data.label || 'Waypoint'),
          classification: cls,
          score: typeof data.score === 'number' ? data.score : 1,
          gridX: typeof data.gridX === 'number' ? data.gridX : 50,
          gridY: typeof data.gridY === 'number' ? data.gridY : 50,
          latitude: typeof data.latitude === 'number' ? data.latitude : undefined,
          longitude: typeof data.longitude === 'number' ? data.longitude : undefined,
          timestamp: ts,
          isManualWaypoint: true,
          sourceDevice: 'Cloud Sync',
        };
      });
      onData(pins);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, colPath);
    }
  );
}

export async function deleteWaypointFromFirestore(
  userId: string,
  waypointId: string
): Promise<void> {
  const uid = sanitizeId(userId);
  const wpId = sanitizeId(waypointId);
  const docPath = `users/${uid}/waypoints/${wpId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'waypoints', wpId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, docPath);
  }
}

export interface CloudChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  modelUsed: string;
  groundingMode: 'none' | 'search' | 'maps';
  sourceUrls: string[];
  createdAtMs: number;
}

export async function saveChatMessageToFirestore(
  userId: string,
  msg: CloudChatMessage
): Promise<void> {
  const uid = sanitizeId(userId);
  const msgId = sanitizeId(msg.id || `msg-${Date.now()}`);
  const docPath = `users/${uid}/chatMessages/${msgId}`;

  const safeUrls = msg.sourceUrls
    .filter((u) => typeof u === 'string' && u.length > 0)
    .slice(0, 8)
    .map((u) => u.slice(0, 512));

  try {
    await setDoc(doc(db, 'users', uid, 'chatMessages', msgId), {
      ownerId: uid,
      role: msg.role === 'model' ? 'model' : 'user',
      text: clampStr(msg.text, 12000, '...'),
      modelUsed: clampStr(msg.modelUsed, 80, 'gemini-4-hydrogen'),
      groundingMode:
        msg.groundingMode === 'search' || msg.groundingMode === 'maps'
          ? msg.groundingMode
          : 'none',
      ...(safeUrls.length > 0 ? { sourceUrls: safeUrls } : {}),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, docPath);
  }
}

export function subscribeUserChatMessages(
  userId: string,
  onData: (messages: CloudChatMessage[]) => void
) {
  const uid = sanitizeId(userId);
  const colPath = `users/${uid}/chatMessages`;
  const q = query(
    collection(db, 'users', uid, 'chatMessages'),
    where('ownerId', '==', uid),
    orderBy('createdAt', 'asc'),
    limit(40)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const msgs: CloudChatMessage[] = snapshot.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        const ts = data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : Date.now();
        return {
          id: d.id,
          role: data.role === 'model' ? 'model' : 'user',
          text: String(data.text || ''),
          modelUsed: String(data.modelUsed || 'gemini-4-hydrogen'),
          groundingMode:
            data.groundingMode === 'search' || data.groundingMode === 'maps'
              ? data.groundingMode
              : 'none',
          sourceUrls: Array.isArray(data.sourceUrls)
            ? data.sourceUrls.map(String).slice(0, 8)
            : [],
          createdAtMs: ts,
        };
      });
      onData(msgs);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, colPath);
    }
  );
}
