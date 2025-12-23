import { useAuth } from "@/context/AuthContext";
import { AtlasProvider } from "@runonatlas/react";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

export function AtlasClientProvider({children}: {children: React.ReactNode}) {
    const navigate = useNavigate();
    const { authToken, globalUser, userLoading } = useAuth();

    const loginCallback = useCallback(() => {
        navigate('/login', { state: { from: window.location.pathname } });
    }, [navigate]);

    return (
        <AtlasProvider
            getAuth={() => {return authToken ?? null}}
            loginCallback={loginCallback}
            userEmail={globalUser?.email}
            userId={globalUser?.id}
            userName={globalUser?.name}
            isUserLoading={userLoading}
        >
            {children}
        </AtlasProvider>
    );
}