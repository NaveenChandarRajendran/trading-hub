// Interactive primitives on Radix UI (headless, ADR 0014), styled only with our tokens (ui.css "rx-" classes).
// Content is portalled to <body>, so it carries the `ds` class itself and the design system's scoped styles apply.
import * as RxDialog from '@radix-ui/react-dialog';
import * as RxMenu from '@radix-ui/react-dropdown-menu';
import * as RxPopover from '@radix-ui/react-popover';
import * as RxTooltip from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';

/** A tooltip on any element. A disabled button gets no pointer events, so it is wrapped in a focusable span. */
export function Tip({ text, children, disabled }: { text: ReactNode; children: ReactElement; disabled?: boolean }) {
  if (!text) return children;
  return (
    <RxTooltip.Provider delayDuration={250}>
      <RxTooltip.Root>
        <RxTooltip.Trigger asChild>{disabled ? <span className="rx-tip-wrap" tabIndex={0}>{children}</span> : children}</RxTooltip.Trigger>
        <RxTooltip.Portal>
          <RxTooltip.Content className="ds rx-tip" sideOffset={6} collisionPadding={8}>{text}<RxTooltip.Arrow className="rx-tip-arrow" /></RxTooltip.Content>
        </RxTooltip.Portal>
      </RxTooltip.Root>
    </RxTooltip.Provider>
  );
}

/** A popover opened by `trigger` (a button). */
export function Popover({ trigger, children, label, align = 'end' }: { trigger: ReactElement; children: ReactNode; label: string; align?: 'start' | 'center' | 'end' }) {
  return (
    <RxPopover.Root>
      <RxPopover.Trigger asChild>{trigger}</RxPopover.Trigger>
      <RxPopover.Portal>
        <RxPopover.Content className="ds card rx-pop" align={align} sideOffset={6} collisionPadding={8} aria-label={label}>{children}</RxPopover.Content>
      </RxPopover.Portal>
    </RxPopover.Root>
  );
}
export const PopoverClose = RxPopover.Close;

/** A modal dialog with a title, a close button, focus kept inside, Esc to close. `wide` for galleries. */
export function Dialog({ open, onOpenChange, title, description, wide, children, className = '' }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; wide?: boolean; children: ReactNode; className?: string;
}) {
  return (
    <RxDialog.Root open={open} onOpenChange={onOpenChange}>
      <RxDialog.Portal>
        <RxDialog.Overlay className="ds rx-overlay" />
        <RxDialog.Content className={`ds card rx-dialog ${wide ? 'wide' : ''} ${className}`}>
          <div className="rx-dialog-head">
            <RxDialog.Title className="card-title">{title}</RxDialog.Title>
            <RxDialog.Close className="btn ghost icon" aria-label="Close">×</RxDialog.Close>
          </div>
          {description ? <RxDialog.Description className="muted rx-small">{description}</RxDialog.Description>
            : <RxDialog.Description className="rx-sr">{title}</RxDialog.Description>}
          {children}
        </RxDialog.Content>
      </RxDialog.Portal>
    </RxDialog.Root>
  );
}

/** A dropdown menu: items are { label, onSelect, disabled?, hint? } or a separator ('-'). */
export type MenuItem = { label: ReactNode; onSelect: () => void; disabled?: boolean; hint?: string } | '-';
export function Menu({ trigger, items, label }: { trigger: ReactElement; items: MenuItem[]; label: string }) {
  return (
    <RxMenu.Root>
      <RxMenu.Trigger asChild>{trigger}</RxMenu.Trigger>
      <RxMenu.Portal>
        <RxMenu.Content className="ds card rx-menu" align="end" sideOffset={6} aria-label={label}>
          {items.map((it, i) => (it === '-' ? <RxMenu.Separator key={i} className="rx-sep" /> : (
            <RxMenu.Item key={i} className="rx-item" disabled={it.disabled} onSelect={it.onSelect} title={it.hint}>{it.label}</RxMenu.Item>
          )))}
        </RxMenu.Content>
      </RxMenu.Portal>
    </RxMenu.Root>
  );
}
