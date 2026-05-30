// ESM wrapper around the UMD build, so you can:
//   import { TerminalPrinter } from './terminal-printer.mjs'
// Works in Node (UMD loads as CommonJS) and in the browser (UMD sets a global).
import cjs from './terminal-printer.js'

const SDK = cjs && cjs.TerminalPrinter ? cjs : globalThis.TerminalPrinterSDK || { TerminalPrinter: globalThis.TerminalPrinter }

export const TerminalPrinter = SDK.TerminalPrinter
export const stableStringify = SDK.stableStringify
export default SDK.TerminalPrinter
