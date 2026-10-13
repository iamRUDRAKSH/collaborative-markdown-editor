import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { readUserName, writeUserName } from "../ds/config";

function HomePage() {
  const [username, setUsername] = useState(() => {
    const stored = readUserName();
    return stored === "Anonymous" ? "" : stored;
  });
  const [roomId, setRoomId] = useState("");
  const [error, setError] = useState("");

  const navigate = useNavigate();

  function saveUsername(): boolean {
    const cleanedUsername = username.trim();

    if (!cleanedUsername) {
      setError("Please enter your name.");
      return false;
    }

    // Stored per tab as well as per browser, so two tabs can be two distinct nodes.
    writeUserName(cleanedUsername);

    setError("");
    return true;
  }

  function createRoom() {
    if (!saveUsername()) {
      return;
    }

    const newRoomId = crypto.randomUUID();
    navigate(`/room/${newRoomId}`);
  }

  function joinRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!saveUsername()) {
      return;
    }

    const cleanedRoomId = roomId.trim();

    if (!cleanedRoomId) {
      setError("Please enter a room ID.");
      return;
    }

    navigate(`/room/${encodeURIComponent(cleanedRoomId)}`);
  }

  return (
    <main className="home-page">
      <section className="home-card">
        <div className="logo">MD</div>

        <h1>Collaborative Markdown Editor</h1>

        <p>
          Create a room and edit a Markdown document with other
          users in real time.
        </p>

        <label className="input-label" htmlFor="username">
          Your name
        </label>

        <input
          id="username"
          className="username-input"
          type="text"
          value={username}
          onChange={(event) => {
            setUsername(event.target.value);
            setError("");
          }}
          placeholder="Enter your name"
          maxLength={30}
        />

        {error && <p className="form-error">{error}</p>}

        <button
          className="primary-button"
          onClick={createRoom}
        >
          Create New Room
        </button>

        <div className="divider">
          <span>or join an existing room</span>
        </div>

        <form className="join-form" onSubmit={joinRoom}>
          <input
            type="text"
            value={roomId}
            onChange={(event) => {
              setRoomId(event.target.value);
              setError("");
            }}
            placeholder="Enter room ID"
            aria-label="Room ID"
          />

          <button type="submit" className="secondary-button">
            Join Room
          </button>
        </form>
      </section>
    </main>
  );
}

export default HomePage;