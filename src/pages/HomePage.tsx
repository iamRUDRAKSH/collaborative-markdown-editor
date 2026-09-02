import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

function HomePage() {
    const [roomId, setRoomId] = useState("");
    const navigate = useNavigate();

    function createRoom() {
        const newRoomId = crypto.randomUUID();
        navigate(`/room/${newRoomId}`);
    }

    function joinRoom(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const cleanedRoomId = roomId.trim();

        if (!cleanedRoomId) {
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
                    Create a room and edit a Markdown document with other users in
                    real time.
                </p>

                <button className="primary-button" onClick={createRoom}>
                    Create New Room
                </button>

                <div className="divider">
                    <span>or join an existing room</span>
                </div>

                <form className="join-form" onSubmit={joinRoom}>
                    <input
                        type="text"
                        value={roomId}
                        onChange={(event) => setRoomId(event.target.value)}
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