import {BrowserRouter,Route,Routes} from 'react-router-dom';
import LandingPage from './LandingPage';
import ConsoleApp from './App';

export default function AppRoutes(){return <BrowserRouter><Routes><Route path="/" element={<LandingPage/>}/><Route path="/console/*" element={<ConsoleApp/>}/></Routes></BrowserRouter>}
