import "./globals.css";
export const metadata = {
  title: "GridStake | P2P sim racing",
  description:
    "Challenge another player on external iRacing and ACC races. Fixed entry terms, verified results, and separate coin wallets.",
  manifest: "/manifest.webmanifest",
};
export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#101213",
};
export default function Layout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
