import { useEffect, useState } from "react";
import { session, sessionListeners } from "./session";
import { BoardView } from "./views/Board";
import { Login } from "./views/Login";
import { ResidentPortal } from "./views/Portal";
import { Workspace } from "./views/Workspace";

export default function App() {
  const [current, setCurrent] = useState(session);

  useEffect(() => {
    const listener = () => setCurrent(session);
    sessionListeners.add(listener);
    return () => {
      sessionListeners.delete(listener);
    };
  }, []);

  if (!current) return <Login />;
  if (current.kind === "resident" && current.resident) {
    return <ResidentPortal key={current.resident.id} resident={current.resident} />;
  }
  if (current.kind === "board") return <BoardView key={current.user.id} name={current.user.name} />;
  return <Workspace key={current.user.id} user={current.user} />;
}
