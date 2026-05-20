export default function HomePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
      }}
    >
      <div style={{ maxWidth: 520, textAlign: "center" }}>
        <h1 style={{ fontSize: "1.6rem", marginBottom: "0.5rem" }}>
          Staff feedback slackbot
        </h1>
        <p style={{ opacity: 0.7, lineHeight: 1.5 }}>
          This service quietly listens for your Slack DMs and helps you draft
          messages to your household staff. There is nothing to see here.
        </p>
      </div>
    </main>
  );
}
