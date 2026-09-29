import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Switch, View } from 'react-native';
import * as Device from 'expo-device';
import { ApiError, HOSTED_URL, pollBrowserSignIn, signIn, startBrowserSignIn } from '../lib/api';
import { Button, Card, ErrorText, Input, Row, Screen, T } from '../components/ui';

/** Sign in to the hosted service or any self-hosted control plane (spec §53). */
export default function Login() {
  const [selfHosted, setSelfHosted] = useState(!HOSTED_URL);
  const [server, setServer] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [mfaStep, setMfaStep] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  // Browser sign-in (device code): works with Google, GitHub, company SSO and two-factor.
  const [browser, setBrowser] = useState<{ userCode: string; verificationUrl: string } | null>(null);
  const cancelled = useRef(false);
  useEffect(() => () => void (cancelled.current = true), []);
  const signInWithBrowser = async () => {
    setBusy(true);
    setError(null);
    cancelled.current = false;
    try {
      const start = await startBrowserSignIn(selfHosted ? server : HOSTED_URL, `Mobile app on ${Device.modelName ?? Platform.OS}`);
      setBrowser({ userCode: start.userCode, verificationUrl: start.verificationUrl });
      void Linking.openURL(start.verificationUrl).catch(() => undefined);
      const deadline = new Date(start.expiresAt).getTime();
      while (!cancelled.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, start.intervalSec * 1000));
        if (cancelled.current) break;
        if (await pollBrowserSignIn(start.pollSecret)) return; // signed in: the layout switches screens
      }
      if (!cancelled.current) throw new Error('The code expired before it was approved. Try again.');
    } catch (e) {
      setError(e);
      setBrowser(null);
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(selfHosted ? server : HOSTED_URL, email.trim(), password, mfaStep ? mfaCode.trim() : undefined);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MFA_REQUIRED') setMfaStep(true);
      else {
        setError(e);
        setMfaCode('');
      }
    } finally {
      setBusy(false);
    }
  };
  if (browser) {
    return (
      <Screen>
        <View style={{ height: 48 }} />
        <T bold style={{ fontSize: 24 }}>Approve in your browser</T>
        <T muted>Sign in there as you usually do (including single sign-on), then approve this code:</T>
        <Card>
          <T bold style={{ fontSize: 28, textAlign: 'center', letterSpacing: 2 }}>
            {browser.userCode}
          </T>
          <T muted>Waiting for approval… If the browser did not open, go to {browser.verificationUrl} on any device.</T>
          <ErrorText error={error} />
          <Button label="Open the browser again" onPress={() => void Linking.openURL(browser.verificationUrl)} />
          <Button
            label="Cancel"
            onPress={() => {
              cancelled.current = true;
              setBrowser(null);
            }}
          />
        </Card>
      </Screen>
    );
  }
  if (mfaStep) {
    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Screen>
          <View style={{ height: 48 }} />
          <T bold style={{ fontSize: 24 }}>Two-factor authentication</T>
          <T muted>Enter the 6-digit code from your authenticator app, or one of your recovery codes.</T>
          <Card>
            <Input label="Authentication code" value={mfaCode} onChangeText={setMfaCode} autoFocus autoCapitalize="none" autoCorrect={false} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" />
            <ErrorText error={error} />
            <Button label="Verify" variant="primary" loading={busy} disabled={!mfaCode.trim()} onPress={() => void submit()} />
            <Button
              label="Back"
              onPress={() => {
                setMfaStep(false);
                setMfaCode('');
                setError(null);
              }}
            />
          </Card>
        </Screen>
      </KeyboardAvoidingView>
    );
  }
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <View style={{ height: 48 }} />
        <T bold style={{ fontSize: 24 }}>Agent Orchestration</T>
        <T muted>Monitor tasks, approve work and respond to agents.</T>
        <Card>
          {HOSTED_URL ? (
            <Row style={{ justifyContent: 'space-between' }}>
              <T>My self-hosted server</T>
              <Switch accessibilityLabel="Use my self-hosted server" value={selfHosted} onValueChange={setSelfHosted} />
            </Row>
          ) : null}
          {selfHosted && <Input label="Server URL" value={server} onChangeText={setServer} placeholder="https://orchestration.example.com" autoCapitalize="none" autoCorrect={false} keyboardType="url" />}
          <Input label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="emailAddress" />
          <Input label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" />
          <ErrorText error={error} />
          <Button label="Sign in" variant="primary" loading={busy} disabled={!email || !password || (selfHosted && !server)} onPress={() => void submit()} />
        </Card>
        <Card>
          <T muted>Use Google, GitHub or your company's single sign-on:</T>
          <Button label="Sign in with your browser" disabled={busy || (selfHosted && !server)} onPress={() => void signInWithBrowser()} />
        </Card>
      </Screen>
    </KeyboardAvoidingView>
  );
}
