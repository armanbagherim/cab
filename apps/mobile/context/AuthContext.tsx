import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../services/api';
import { socketService } from '../services/socket';
import { User } from '../types';

interface AuthCtx {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (token: string, user: User) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (user: User) => void;
}

const AuthContext = createContext<AuthCtx>({ user: null, token: null, isLoading: true, login: async () => {}, logout: async () => {}, updateUser: () => {} });

/**
 * SecureStore has no (official) web implementation — fall back to
 * AsyncStorage on web, keep the secure keychain/keystore path on native.
 */
const storage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') return AsyncStorage.getItem(key);
    return SecureStore.getItemAsync(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') { await AsyncStorage.setItem(key, value); return; }
    await SecureStore.setItemAsync(key, value);
  },
  async removeItem(key: string): Promise<void> {
    if (Platform.OS === 'web') { await AsyncStorage.removeItem(key); return; }
    await SecureStore.deleteItemAsync(key);
  },
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const bootedRef = useRef(false);

  // Stable ref to logout so we can pass it to api without stale closures.
  const logoutRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    loadStored().finally(() => setIsLoading(false));
  }, []);

  // Socket lifecycle tied strictly to the token.
  useEffect(() => {
    if (token) {
      socketService.connect(token);
    }
    return () => {
      socketService.disconnect();
    };
  }, [token]);

  async function loadStored() {
    try {
      const t = await storage.getItem('auth_token');
      const u = await storage.getItem('auth_user');
      if (t && u) {
        const parsed = JSON.parse(u) as User;
        api.setToken(t);
        setToken(t);
        setUser(parsed);
      }
    } catch (e) {
      // corrupted storage — behave as signed out
      api.setToken(null);
    }
  }

  const login = useCallback(async (newToken: string, newUser: User) => {
    await storage.setItem('auth_token', newToken);
    await storage.setItem('auth_user', JSON.stringify(newUser));
    api.setToken(newToken);
    setToken(newToken);
    setUser(newUser);
  }, []);

  const updateUser = useCallback((next: User) => {
    setUser(next);
    storage.setItem('auth_user', JSON.stringify(next)).catch(() => {});
  }, []);

  const logout = useCallback(async () => {
    await storage.removeItem('auth_token').catch(() => {});
    await storage.removeItem('auth_user').catch(() => {});
    socketService.disconnect();
    api.setToken(null);
    setToken(null);
    setUser(null);
    // Central redirect on EVERY sign-out path (button logout and the silent
    // global-401 handler). Without this, a 401 while the user is on a group
    // screen leaves them stranded with no way back to login.
    router.replace('/');
  }, []);

  // Keep ref in sync so api can call it without a stale closure.
  logoutRef.current = logout;

  // Register a global 401 handler: any API call that gets an Unauthorized
  // response automatically signs the user out and returns them to the root.
  useEffect(() => {
    api.setUnauthorizedHandler(() => {
      logoutRef.current().catch(() => {});
    });
    return () => {
      api.setUnauthorizedHandler(null);
    };
  }, []);

  return <AuthContext.Provider value={{ user, token, isLoading, login, logout, updateUser }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
