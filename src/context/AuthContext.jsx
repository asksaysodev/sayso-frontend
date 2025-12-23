import { createContext, useContext, useEffect, useState, useRef } from 'react'
import { supabase } from '../config/supabase'
import { useAccounts } from '../hooks/useAccounts'
import { useLocation } from 'react-router-dom'

// Define the shape of our auth context
const AuthContext = createContext({})

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [globalUser, setGlobalUser] = useState(null)
  const [authToken, setAuthToken] = useState(null)
  const [userLoading, setUserLoading] = useState(true)
  const prevUserRef = useRef(null)
  const location = useLocation()

  const { createAccount, getAccount } = useAccounts()

  // Wrapper function to handle localStorage updates
  const updateGlobalUserState = (newGlobalUser) => {
    if (newGlobalUser === null) {
      localStorage.removeItem('sayso-global-user')
    } else {
      localStorage.setItem('sayso-global-user', JSON.stringify(newGlobalUser))
    }
    setGlobalUser(newGlobalUser)
  }

  const updateGlobalUser = async (accountEmail) => {
    try{
      const account = await getAccount(accountEmail);
      updateGlobalUserState(account);
    } catch (error) {
      console.error('Error updating global user:', error); 
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut();

    setUser(null);
    updateGlobalUserState(null);
    setAuthToken(null);
    
    if (window.electron?.ipcRenderer) {
      window.electron.ipcRenderer.send('update-user-auth', { isAuthenticated: false });
    }
  }

  // Handle session expiration
  useEffect(() => {
    const handleSessionExpired = () => {
      console.log('🔐 AuthContext: Session expired event received');
      setUser(null);
      updateGlobalUserState(null);
      setAuthToken(null);
    };

    window.addEventListener('auth:session-expired', handleSessionExpired);

    return () => {
      window.removeEventListener('auth:session-expired', handleSessionExpired);
    };
  }, []);

  useEffect(() => {
    // Skip auth check for /zoom-success
    if (location.pathname === '/zoom-success') {
      setLoading(false)
      return
    }

    // Check active sessions and sets the user
      supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      prevUserRef.current = session?.user ?? null
      setLoading(false)
    })

    // Listen for changes on auth state (sign in, sign out, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      
      // Only update state for actual auth events
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        // Prevent unnecessary state updates if the user hasn't actually changed
        const newUser = session?.user ?? null
        if (JSON.stringify(newUser) !== JSON.stringify(prevUserRef.current)) {
          setUser(newUser)
          prevUserRef.current = newUser
          setAuthToken(session?.access_token ?? null)
          setLoading(false)
        }
      }
    })

    return () => subscription.unsubscribe()
  }, [location])

  useEffect(() => {
    let timeoutId;

    // Always set userLoading to true when user changes (even if user is null)
    setUserLoading(true);

    if (user) {
      // Add a small delay to prevent rapid re-fetching
      timeoutId = setTimeout(() => {
        getAccount(user.email).then((account) => {
          updateGlobalUserState(account)
          setUserLoading(false)
          
          if (window.electron?.ipcRenderer) {
            window.electron.ipcRenderer.send('update-user-auth', { isAuthenticated: true });
          }
        })
      }, 300) // 300ms delay
    } else {
      updateGlobalUserState(null)
      setUserLoading(false)
      
      if (window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.send('update-user-auth', { isAuthenticated: false });
      }
    }

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }, [user])

  const value = {
    signUp: async (data) => {
      // First, sign up with Supabase Auth
      const result = await supabase.auth.signUp(data)
      // If sign up is successful, create the account in the DB
      if (!result.error) {
        // Try to get user info from the data/options
        const { email, options } = data
        const { name, lastname, company } = options?.data || {}
        try {
          await createAccount({ email, name, lastname, company })
        } catch (err) {
          console.error('Error creating account in DB:', err)
        }
      }
      return result
    },
    signIn: (data) => supabase.auth.signInWithPassword(data),
    handleSignOut,
    globalUser,
    authToken,
    userLoading,
    loading,
    updateGlobalUser,
  }

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  return useContext(AuthContext)
} 