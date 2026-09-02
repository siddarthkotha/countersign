import { useState } from 'react';
import Landing from './screens/Landing';
import Replay from './screens/Replay';

type Screen = 'landing' | 'replay' | 'call';

export default function App() {
  const [screen, setScreen] = useState<Screen>('landing');

  if (screen === 'replay') {
    return <Replay />;
  }

  if (screen === 'call') {
    return <div>Call (W3)</div>;
  }

  return <Landing onWatch={() => setScreen('replay')} onCall={() => setScreen('call')} />;
}
