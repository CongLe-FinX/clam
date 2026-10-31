import { getRouteApi } from "@tanstack/react-router";
import LoginPage from "./login-page.tsx";

const route = getRouteApi("/login");

export default function LoginRoute() {
	const { redirect } = route.useSearch();
	return <LoginPage redirect={redirect} />;
}
