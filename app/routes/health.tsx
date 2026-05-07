export const loader = async () => {
  console.log("HEALTH CHECK HIT");
  return new Response("OK AGENT CLAUDE BUILD 2026-05-07", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
};
