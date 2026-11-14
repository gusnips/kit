# @gusnips/native

What a bare React Native app needs beside `@gusnips/react`: the Metro config for a bun monorepo,
the Tailwind build for react-native-css, streams from your API, React Query that knows when the app
is in the background, and a theme and a language that remember what the person picked. No Expo.

```bash
bun add @gusnips/native
```

```js
// metro.config.js
const { getDefaultConfig } = require("@react-native/metro-config");
const { nativeMetroConfig } = require("@gusnips/native/metro");

module.exports = nativeMetroConfig(getDefaultConfig(__dirname));
```

That one line makes every `react` import in the bundle the app's own copy, and maps
react-native-css's override module so styled components load. Both are crashes you would otherwise
meet at launch.

## What is in it

| Import                     | What it does                                                   | Also needs                                            |
| -------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `@gusnips/native`          | `openSseStream`: server-sent events over XHR                   | nothing more                                          |
| `@gusnips/native/theme`    | `createNativeTheme`: light, dark or system, remembered         | `@react-native-async-storage/async-storage`           |
| `@gusnips/native/network`  | `useIsOffline`, `isDeviceOffline`                              | `@react-native-community/netinfo`                     |
| `@gusnips/native/query`    | `installQueryManagers`: React Query on app focus and network   | `@tanstack/react-query`, netinfo                      |
| `@gusnips/native/i18n`     | `createNativeLanguage`: the phone's language, or the saved one | `react-native-localize`, async-storage, `i18next`     |
| `@gusnips/native/supabase` | `supabaseAuthStorage`: where supabase-js keeps the session     | async-storage, `@supabase/supabase-js`                |
| `@gusnips/native/metro`    | `nativeMetroConfig`, for `metro.config.js`                     | nothing more                                          |
| `@gusnips/native/css`      | `buildNativeCss` and the `gusnips-native-css` command          | `@tailwindcss/cli`, `tailwindcss`, `react-native-css` |

Every app needs `react`, `react-native`, `@gusnips/react` and `@gusnips/http`. The rest are
optional: you install one only when you import the line that uses it. Most of them carry native
code that has to be linked into the app, so an app that does not use NetInfo should not have to
ship it.

## Metro

In a monorepo, tell it where the root is:

```js
module.exports = nativeMetroConfig(getDefaultConfig(__dirname), {
  monorepoRoot: require("node:path").resolve(__dirname, "../.."),
});
```

What it adds to the config:

- **The monorepo.** `watchFolders` and `nodeModulesPaths` point at the root, so a workspace package
  that ships TypeScript source resolves like any other. Metro does not find workspaces on its own.
- **One React.** bun's isolated store keeps a spare `react` at its root. A package that forgets to
  declare react as a peer finds that one instead, and the bundle has two: your screens render, and
  that package's hooks crash with "Cannot read property 'useMemo' of null". Every `react` and
  `react/*` import now goes to the copy your app resolves. `react-native` and `react-dom` are left
  alone.
- **react-native-css's override module.** `react-native-css/native` imports a module that throws
  unless Metro maps it to the package's empty `override.js`. Without the mapping every styled
  component fails with "Cannot read property 'useCssElement' of undefined". Skipped when the app
  does not use react-native-css.

A resolver already on the config still runs for everything else.

**`metro.config.js` stays CommonJS, as the React Native template writes it.** This package is ES
modules only, and `require()` of an ES module works without a flag on every Node version React
Native 0.86 supports: 20.19.4 and later, 22.13 and later, 24.3 and later. Measured by loading the
config through Metro's own `loadConfig` on Node 22.22 and 24.21.

Never add `withReactNativeCSS` or NativeWind's `withNativewind` on top. Both also replace Metro's
transformer with one that requires `@expo/metro-config`, and Metro crashes on a bare app. The CSS
is built ahead of time instead, below.

## Styles: Tailwind on React Native

NativeWind v5 and react-native-css read `className` at runtime against a compiled stylesheet.
`gusnips-native-css` builds that stylesheet from your `global.css`, with the Tailwind v4 CLI and
then react-native-css's compiler:

```bash
gusnips-native-css   # global.css → src/generated/stylesheet.ts
```

Run it before Metro, in the same script, or a class you just added resolves to nothing:

```json
{
  "scripts": {
    "start": "gusnips-native-css && react-native start",
    "ios": "gusnips-native-css && react-native run-ios",
    "android": "gusnips-native-css && react-native run-android"
  }
}
```

Then load the stylesheet once, at the top of `App.tsx`:

```ts
import { StyleCollection } from "react-native-css/native-internal";
import { stylesheet } from "./generated/stylesheet";

StyleCollection.inject(stylesheet);
```

Never import `global.css` from `index.js`: NativeWind warns that it breaks Fast Refresh, and the
compiled file is what the app reads. Add `src/generated/` to `.gitignore`.

The tools come from your app, not from this package, because the stylesheet must match the
react-native-css your bundle runs:

```bash
bun add react-native-css && bun add -d @tailwindcss/cli tailwindcss
```

Five things worth knowing:

- **One `rem` is 16 pixels, as on the web.** react-native-css's own default is 14, React Native's
  root font size, which shrinks every rem-based size by an eighth: `h-12` comes out 42 px instead
  of 48. `--rem` changes it if you really want another value.
- **Tailwind finds your classes by itself** in the app's folder. Tailwind v4 has no `--content`
  flag. For a file outside the folder, add an `@source` line to `global.css`.
- **Pin lightningcss to 1.30.1, or use a version after 1.30.2.** 1.30.2 breaks react-native-css's
  compiler, and react-native-css's own check for it is swallowed by an empty `catch`. The build
  refuses 1.30.2 instead. Pin it with `"overrides": { "lightningcss": "1.30.1" }` in the root
  `package.json`: a devDependency is not enough, because react-native-css loads the copy under
  `@expo/metro-config` first.
- **A `className` change hot-reloads.** Only a change to `global.css` or your tokens needs the
  build to run again.
- **There is no global font.** react-native-css drops element and `*` selectors, so a text without
  a `font-*` class renders in the system font.

### Colours for code

An icon's `color`, the navigation theme and the status bar take a hex string, not a class. Name
the colours in a JSON file, each as a class per scheme:

```json
{
  "text": { "light": "text-ink", "dark": "dark:text-ink-dark" },
  "canvas": { "light": "bg-surface", "dark": "dark:bg-surface-dark" }
}
```

`gusnips-native-css --palette palette.json` writes `colors.ts` beside the stylesheet, with the hex
each class compiles to. The colours come from the stylesheet itself, so a change of tokens moves the
icons with the text. Tailwind writes only classes it finds in your files, so keep each palette
class in your source; the build stops and names any it cannot find.

From a script, the same build is `buildNativeCss({ palette })` from `@gusnips/native/css`.

## Streams

React Native's `fetch` cannot read a response as it arrives, so `readSseStream` from
`@gusnips/react` has nothing to read. `openSseStream` uses `XMLHttpRequest`, which can, and the
same frame parser:

```ts
import { openSseStream } from "@gusnips/native";

const stream = openSseStream({
  url: `${API_URL}/chat/stream`,
  body: { message },
  headers: authHeaders,
  refreshHeaders: refreshAuthHeaders,
  onFrame: ({ event, data }) => handle(event, JSON.parse(data)),
  onError: showError,
});

stream.abort(); // when the screen closes
```

- A refused stream fails with the same `ApiError` your API client throws, with the code, the
  request id and the `Retry-After` wait. So a 402 on a stream gets the same sentence and button as
  any other 402. A lost connection is a plain `Error`, which the describer reads as "never
  landed".
- On a 401 it calls `refreshHeaders` once and opens again. Pass the refresh your API client uses,
  so a stream and a page load do not refresh the session at the same time. Return `null` when
  there is no session, and the stream fails with the 401.
- `data` is raw text. Parse it the way your server writes it.
- No reconnect. Reopen the stream from where your screen knows how to recover.
- The whole response stays in memory until the stream ends. Fine for a chat answer; not for a feed
  left open all day.

## React Query

```ts
import { queryDefaults } from "@gusnips/react";
import { installQueryManagers } from "@gusnips/native/query";

installQueryManagers();
export const queryClient = new QueryClient({ defaultOptions: queryDefaults() });
```

React Query's own defaults watch the browser's window and `navigator.onLine`, which a phone does
not have. After this, retries wait while the app is in the background or offline, and stale
queries run again when the connection returns.

It does **not** refetch when the app comes back to the foreground: `queryDefaults` leaves
`refetchOnWindowFocus` off. For an app people leave open for days, you probably want it on:
`queryDefaults({ refetchOnWindowFocus: true })`.

## Offline

```ts
import { useIsOffline } from "@gusnips/native/network";

const offline = useIsOffline(); // true while the phone has no connection
```

`isDeviceOffline()` answers the same question once. React Native's `fetch` fails the same way
whether the server is down or the phone has no signal, so ask it before you tell someone the
service is having trouble. While NetInfo is still working it out, both say "online", so no
offline banner flashes at launch.

## Theme

The same options and the same `useTheme` as `@gusnips/react/theme`, applied with
`Appearance.setColorScheme`, which is what `useColorScheme()` and the `dark:` classes read:

```ts
import { createNativeTheme } from "@gusnips/native/theme";

export const theme = createNativeTheme({ key: "app:theme" });

// In the root component:
useEffect(() => theme.start(), []);

// Anywhere:
const { mode, resolved, setMode } = theme.useTheme();
```

`start()` loads the saved choice and puts it back each time the app returns to the foreground,
because Android drops the choice when it recreates the screen. A choice made while the saved one is
still loading wins over it.

## Language

```ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { createNativeLanguage } from "@gusnips/native/i18n";

export const language = createNativeLanguage(i18n, {
  supported: ["pt-BR", "en"],
  storageKey: "app:language",
});

i18n.use(language.detector).use(initReactI18next).init({ resources, fallbackLng: "pt-BR" });
```

At launch, call `language.restore()`. From your language picker, call `language.choose("en")`, or
`language.choose(null)` to follow the phone again.

- The first render is already in the phone's language. The saved choice is read after, and wins.
- The phone's languages are read in its order: on `pt-PT, en-US` the app picks `pt-BR`, and on
  `fr-FR, en-US` it picks `en` instead of the fallback.
- Only `choose` saves a language. i18next hands every language change to the detector, including
  the one it detects at launch, so a detector that saved there would treat the phone's language as
  the person's choice, and the app would ignore the phone from then on.

## Supabase

```ts
import { supabaseAuthStorage } from "@gusnips/native/supabase";

export const authStorage = supabaseAuthStorage(SUPABASE_URL);
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { ...authStorage, detectSessionInUrl: false, flowType: "pkce" },
});

await signOutEvenOffline(supabase.auth, authStorage); // from @gusnips/react/supabase
```

The session goes in AsyncStorage, not the keychain: a session is two tokens and the user's data in
one value, and it often passes the about 2 KB a keystore holds per value. The key is the one
supabase-js picks itself, so moving onto this signs nobody out. Pass the same object to
`signOutEvenOffline`, so the sign-out clears the key the client reads.

Use `flowType: "pkce"`. A sign-in returns through your app's URL scheme, which any app can claim,
and under the default flow that URL carries the refresh token.

## Also worth knowing

- **Do not use `react-native-css/components/react-native-safe-area-context`.** In 3.0.7 everything
  under it loses its `className` styles. Use `SafeAreaView` from `react-native-safe-area-context`
  with `style={{ flex: 1 }}`, and put the colours on a styled `View` inside it.
- **`nativewind/babel` is a preset, not a plugin.** Put it in `presets` in `babel.config.js`.
- **Keep React at one version in the whole repo**, with the root `workspaces.catalog`. The Metro
  resolver protects the bundle from bun's store layout; the catalog stops the versions drifting in
  the first place.

## Why the dependencies are peers

There are no `dependencies`. Each package here is one your app already has, or one that carries
native code, and an app must have exactly one copy of each:

- `react`, `react-native`: two copies of either breaks the app.
- `@gusnips/react` is a peer, not a dependency, on purpose. `@gusnips/vite` depends on it, so its
  release pins one exact version, and an app on another version gets a second copy nested inside
  vite. A peer uses yours. Its range is `>=0.10.0 <1`, so a new minor of `@gusnips/react` does not
  need a release of this package.
- `@gusnips/http`: `openSseStream` reads the error envelope and `Retry-After` with it, the same
  functions the API client uses. Same reasoning, same kind of range.
- AsyncStorage, NetInfo and react-native-localize hold native code that autolinking compiles into
  the app, so each is optional and behind its own import.
- `tailwindcss`, `@tailwindcss/cli` and `react-native-css` are read from your app's folder at build
  time, so the stylesheet matches what your bundle runs.
