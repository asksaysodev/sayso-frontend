//CONTEXT PROVIDERS
import { AtlasClientProvider } from './atlas/client';
import { AuthProvider } from './context/AuthContext';
import { ProspectsProvider } from './context/ProspectsContext';
import { SalesCoachProvider } from './context/SalesCoachContext';
import { ToastProvider } from './context/ToastContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient();

export default function Providers({ children }) {
    return (
        <QueryClientProvider client={queryClient}>
            <ToastProvider>
                <AuthProvider>
                    <AtlasClientProvider>
                        <ProspectsProvider>
                            <SalesCoachProvider>
                                {children}
                            </SalesCoachProvider>
                        </ProspectsProvider>
                    </AtlasClientProvider>
                </AuthProvider>
            </ToastProvider>
        </QueryClientProvider>
    );
}
