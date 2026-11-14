/**
 * Where supabase-js keeps the session on a phone.
 *
 * AsyncStorage and not the keychain (or a SecureStore): a session is the access token, the refresh
 * token and the user's metadata in one JSON value, and it routinely passes the roughly 2 KB a
 * platform keystore takes per value. AsyncStorage is private to the app on both platforms, and it is
 * what Supabase's own React Native guide uses.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabaseStorageKey, type SupabaseSessionStorage } from "@gusnips/react/supabase";

/**
 * The phone's `supabaseAuthStorage`. Build it once and pass it both to `createClient`'s `auth` and
 * to `signOutEvenOffline`, so the sign-out clears the exact key the client reads:
 *
 * ```ts
 * export const authStorage = supabaseAuthStorage(SUPABASE_URL);
 * export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
 *   auth: { ...authStorage, detectSessionInUrl: false, flowType: "pkce" },
 * });
 * ```
 *
 * The key is the one supabase-js picks for itself, so moving an app onto this signs nobody out.
 * On a phone, pass `flowType: "pkce"` as above: a sign-in comes back through a custom scheme any app
 * can claim, and under the implicit flow that URL carries the refresh token itself.
 */
export function supabaseAuthStorage(supabaseUrl: string): SupabaseSessionStorage {
  return { storage: AsyncStorage, storageKey: supabaseStorageKey(supabaseUrl) };
}
