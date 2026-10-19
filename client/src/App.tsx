import { useEffect, useState } from "react";
import { api, type OfficeUser, session, sessionListeners, setSession } from "./session";
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

  // Henkilökunnan rooli ja sen näkemät taulut haetaan palvelimelta joka latauksella, jotta pääkäyttäjän
  // tekemät roolimuutokset tulevat voimaan ilman uutta kirjautumista.
  const staffToken = current && !current.kind ? current.token : null;
  useEffect(() => {
    if (!staffToken) return;
    api<OfficeUser>("/auth/me")
      .then(user => {
        if (session?.token === staffToken) setSession({ ...session, user: { ...session.user, ...user } });
      })
      .catch(() => undefined);
  }, [staffToken]);

  if (!current) return <Login />;
  if (current.kind === "resident" && current.resident) {
    return <ResidentPortal key={current.resident.id} resident={current.resident} />;
  }
  if (current.kind === "board") return <BoardView key={current.user.id} name={current.user.name} />;
  return <Workspace key={current.user.id} user={current.user} />;
}
