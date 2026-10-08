import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import App from "./App";
import { loadConfig, type Runtime } from "./config";
import { explain } from "./chain";
import "./styles.css";
function Bootstrap() {
  const [rt, setRt] = useState<Runtime>(),
    [error, setError] = useState("");
  useEffect(() => {
    loadConfig()
      .then(setRt)
      .catch((e) => setError(explain(e)));
  }, []);
  if (rt) return <App rt={rt} />;
  return (
    <main className="boot">
      <img src="./mark.svg" width="48" height="48" alt="" />
      <h1>Swarm Harvester</h1>
      <p role={error ? "alert" : "status"}>
        {error || "Loading the deployment and verifying its ABIs…"}
      </p>
      {error && (
        <button className="button" onClick={() => window.location.reload()}>
          Reload deployment
        </button>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Bootstrap />);
