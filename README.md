# Chess Voice

Play chess against friends or random opponents, with live voice chat during the game.
Games are real Lichess games (played through the Lichess Board API). This app adds the voice layer.

## Run it

```
npm install
npm start
```

Then open http://localhost:3000. To test a game alone, use two browsers (or one normal window and
one incognito window) logged into two different Lichess accounts.

## How it works

| Piece | What it does |
| --- | --- |
| `client/lichess.js` | "Log in with Lichess" (OAuth PKCE, no app registration needed) and API/stream helpers |
| `client/main.js` | Lobby, random matchmaking (Lichess seeks), and invite links |
| `client/game.js` | Board (Lichess's chessground), clocks, resign/draw, and the voice panel |
| `client/voice.js` | WebRTC peer-to-peer audio |
| `server.js` | Serves the app, pairs invite-link players, and relays WebRTC signaling |

- **Random opponent:** the browser posts a seek to Lichess and keeps it open until someone accepts.
  Lichess only allows rapid and classical for third-party seeks.
- **Friend invite:** the host gets a link. When the friend opens it and clicks Accept, the server tells
  the host's browser, which sends a Lichess challenge to the friend. The friend's browser then accepts it
  automatically. Blitz is allowed here.
- **Voice:** both players must click "Join voice." The server checks with Lichess that each person is a
  player in that game, then relays the WebRTC handshake. Audio goes directly between the two browsers.

## Before going public

- **TURN server.** Without one, voice fails for some players behind strict networks. Set `TURN_URL`,
  `TURN_USERNAME` and `TURN_CREDENTIAL` (self-host coturn, or use a provider like Metered or Twilio).
- **HTTPS.** Browsers only allow microphone access on `https://` (or localhost).
- **Safety.** Add a report and block flow for voice abuse, and decide on an age policy.
- **License.** chessground is GPL-3.0, so this project is GPL-3.0 and its source must stay public.
- **Lichess terms.** Respect API rate limits, and don't present the site as Lichess.
