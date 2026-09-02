import { useState } from 'react';
import Landing from './screens/Landing';
import Replay from './screens/Replay';
import Call, { type StartedSession } from './screens/Call';

type Screen = 'landing' | 'replay' | 'call';

export default function App() {
  const [screen, setScreen] = useState<Screen>('landing');
  const [session, setSession] = useState<StartedSession | null>(null);

  if (screen === 'replay') {
    return <Replay />;
  }

  if (screen === 'call' && session) {
    return (
      <Call
        session={session}
        onWatch={() => {
          setSession(null);
          setScreen('replay');
        }}
        onStartOver={() => {
          setSession(null);
          setScreen('landing');
        }}
      />
    );
  }

  return (
    <Landing
      onWatch={() => setScreen('replay')}
      onCall={(result) => {
        setSession(result);
        setScreen('call');
      }}
    />
  );
}
