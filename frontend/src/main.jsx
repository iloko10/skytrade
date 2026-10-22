import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import AirlineConsole from "./AirlineConsole.jsx";

// "/" is the traveller app, "/#console" is the airline revenue console.
function Root() {
  const [hash, setHash] = React.useState(window.location.hash);
  React.useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash === "#console" ? <AirlineConsole /> : <App />;
}

createRoot(document.getElementById("root")).render(<Root />);
