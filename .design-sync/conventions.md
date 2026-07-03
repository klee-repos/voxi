## Building with Voxi

Voxi is a **React Native** design system (it ships an iOS app; these previews render via react-native-web).
The components are real React Native components — you compose them and style your own layout glue with **React
Native primitives and style objects, NOT HTML/CSS**. There are no `className`s and no CSS files to import.

### Setup — wrap everything in the theme provider

Every component reads the active theme through `useTheme()` and **throws if it isn't inside `ThemeProvider`**.
Wrap your whole tree once:

```tsx
import { ThemeProvider, SurfaceProvider, Screen, Title, Body, Button, ConfidenceChip } from '<library>'
import { View } from 'react-native'

<ThemeProvider>
  <Screen padded>
    <ConfidenceChip band="CONFIDENT" />
    <Title>Eames Lounge Chair</Title>
    <Body>A moulded plywood-and-leather lounge chair — a mid-century icon of considered comfort.</Body>
    <View style={{ marginTop: 24 }}>
      <Button id="listen" label="Hear the story" variant="primary" onPress={() => {}} />
    </View>
  </Screen>
</ThemeProvider>
```

There are **two surfaces**. `ThemeProvider` defaults to the warm **parchment** (cream `#F4F1E8`) reading surface
— correct for the reveal card, collection, forms, and text. For the **dark shell** (charcoal `#17181A`: camera,
voice, the Deep Dive player, anything over a photo) wrap that subtree in `<SurfaceProvider surface="dark">`.
Never hand-set component colors — pick the surface and the component colors itself.

### The styling idiom: semantic props + surface, not CSS

The design language lives in each component's **props**, not in class names or color values you pass:

- `Button` → `variant="primary" | "secondary" | "danger"` (green fill / hairline outline / terracotta).
- `ConfidenceChip` → `band="CONFIDENT" | "PROBABLE" | "UNKNOWN"` (solid green / gold outline / neutral).
- `Orb` → `state="idle" | "listening" | "thinking" | "speaking" | "uncertain"` (the narrator character).
- Text: `Title` (heading), `Body`, `Muted`, `Link` (blue), `Wordmark` (the serif "voxi" logotype — the ONLY serif).

For your OWN layout glue, use `View`/`Text`/`ScrollView` from `react-native` with **RN style objects** —
flexbox, and numeric values (`padding: 24`, `borderRadius: 20`, `gap: 12`), never px strings or CSS. The brand
palette when you need a raw value: **green `#29AB60`** = primary / audio action, **blue `#3D89F5`** = links /
secondary, cream `#F4F1E8` and charcoal `#17181A` are the two canvases. Controls are **fully-rounded pills**.
Type is **Nunito** (UI sans) with **Fraunces** reserved for the `Wordmark` only.

### Where the truth lives

Read each component's `<Name>.prompt.md` (usage + examples) and `<Name>.d.ts` (exact prop types) before using
it. Import the two surface tokens `dark` / `parchment` from the library if a component takes a `surface` prop
directly (a few do: `KaraokeTranscript`, `ConfirmDialog`, `BucketDock`, `BucketCard`). Note that most components
require an `id` string (it wires the app's accessibility/testing contract) — pass any stable string.
