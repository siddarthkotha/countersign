import { useState } from 'react';
import Landing from './screens/Landing';
import Replay from './screens/Replay';
import Call, { type StartedSession } from './screens/Call';
import type { DemoPersona } from './api';

type Screen = 'landing' | 'replay' | 'call';

export default function App() {
  const [screen, setScreen] = useState<Screen>('landing');
  const [session, setSession] = useState<StartedSession | null>(null);
  const [persona, setPersona] = useState<DemoPersona | null>(null);

  if (screen === 'replay') {
    return <Replay />;
  }

  if (screen === 'call' && session) {
    return (
      <Call
        session={session}
        persona={persona}
        onWatch={() => {
          setSession(null);
          setPersona(null);
          setScreen('replay');
        }}
        onStartOver={() => {
          setSession(null);
          setPersona(null);
          setScreen('landing');
        }}
      />
    );
  }

  return (
    <Landing
      onWatch={() => setScreen('replay')}
      onCall={(result, selectedPersona) => {
        setSession(result);
        setPersona(selectedPersona);
        setScreen('call');
      }}
    />
  );
}
