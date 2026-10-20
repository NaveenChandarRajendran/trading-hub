import { AllCommunityModule, ModuleRegistry, colorSchemeDark, colorSchemeLight, themeQuartz } from 'ag-grid-community';
import { useTheme } from './theme';

ModuleRegistry.registerModules([AllCommunityModule]);

const base = themeQuartz.withParams({
  fontFamily: 'Inter, system-ui, sans-serif', fontSize: 12, accentColor: '#387ed1',
  headerHeight: 40, rowHeight: 28, spacing: 5, wrapperBorderRadius: 6,
});
const light = base.withPart(colorSchemeLight);
const dark = base.withPart(colorSchemeDark);

/** AG Grid theme that follows the app's light/dark toggle. */
export const useGridTheme = () => (useTheme().mode === 'dark' ? dark : light);

export const inr = (d = 0) => (v: number | null | undefined) =>
  v == null ? '' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Change with an explicit sign and a real minus: +1,250 / −830 / 0. */
export const signed = (d = 0) => (v: number | null | undefined) =>
  v == null ? '' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${inr(d)(Math.abs(v))}`;
