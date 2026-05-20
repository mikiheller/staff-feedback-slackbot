export const metadata = {
  title: "Staff feedback slackbot",
  description: "Private drafting bot for household staff messages.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          margin: 0,
          padding: 0,
          background: "#0b0b0d",
          color: "#e7e7e9",
        }}
      >
        {children}
      </body>
    </html>
  );
}
