// packages/web/src/components/Footer.tsx
// Task W5, fix round 2, requirement 3: the footer bar on Call/Replay. Left keeps the
// existing sentence verbatim (Call.tsx used to render this itself as `.bottom-line`; Footer
// is now the one place both screens get it from). Right shows the export hash in amber
// monospace once one exists -- never the mockup's "Sealed record" wording ("sealed" is
// banned, LAW 1); when there is no hash yet (`export_hash` is null pre-verdict, or no call
// has produced a ScreenState at all), that side is simply omitted.
//
// Task W6, fix round 1 (controller ruling: the footer KEEPS the full hash -- it is the
// look's footer element, not a duplicate to remove): the label now matches CallView.tsx's
// forensic-section export line ("hash-chained evidence export"), and the full hash carries
// a `title` too, same as the banner's short-hash hover -- one vocabulary, one hover pattern,
// in both places the hash appears.
export type FooterProps = {
  exportHash?: string | null;
};

const BOTTOM_LINE = 'No funds can move by voice alone. Second approval required.';

export default function Footer({ exportHash }: FooterProps) {
  return (
    <footer className="cs-footer">
      <p className="bottom-line">{BOTTOM_LINE}</p>
      {exportHash && (
        <p className="footer-hash" title={exportHash}>
          hash-chained evidence export (each record fingerprinted to detect edits) · {exportHash}
        </p>
      )}
    </footer>
  );
}
