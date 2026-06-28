/// <reference types="vite/client" />

// Fontsource packages resolve their "." export to a CSS file and ship no type
// declarations. TS 6 (TS2882) flags side-effect imports of such modules, so
// declare them as empty ambient modules.
declare module "@fontsource-variable/geist";
declare module "@fontsource-variable/geist-mono";
