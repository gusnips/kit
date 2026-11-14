// @gusnips/native: what a bare React Native app needs beside @gusnips/react.
//
// The rule that picks the subpaths is the kit's invariant 15, checked by `bun run exports`: a peer
// marked optional must not be reachable from this entry. Every subpath below needs one more package
// with native code or a build tool in it, and an app installs that package only by importing the
// thing that uses it:
//
//   @gusnips/native/theme     createNativeTheme, useThemeColors → @react-native-async-storage/async-storage
//   @gusnips/native/network   useIsOffline             → @react-native-community/netinfo
//   @gusnips/native/query     installQueryManagers     → @tanstack/react-query, netinfo
//   @gusnips/native/i18n      createNativeLanguage     → react-native-localize, async-storage
//   @gusnips/native/supabase  supabaseAuthStorage      → async-storage, @supabase/supabase-js
//   @gusnips/native/metro     nativeMetroConfig        → Node, at bundle time
//   @gusnips/native/css       buildNativeCss           → Node, tailwindcss, react-native-css
//
// What is left here needs only the required peers.

export { openSseStream, type SseStream, type SseStreamOptions } from "./sse.ts";
