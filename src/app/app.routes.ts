import { Routes } from '@angular/router';
import { adminGuard, staffGuard } from './core/auth/staff.guard';

export const routes: Routes = [
	{ path: '', pathMatch: 'full', redirectTo: 'login' },
	{
		path: 'login',
		loadComponent: () => import('./features/auth/login.page').then((page) => page.LoginPage),
	},
	{
		canActivate: [staffGuard],
		path: '',
		loadComponent: () => import('./app-shell').then((shell) => shell.AppShell),
		children: [
			{ path: '', pathMatch: 'full', redirectTo: 'dashboard' },
			{
				path: 'dashboard',
				loadComponent: () => import('./features/dashboard/dashboard.page').then((page) => page.DashboardPage),
			},
			{
				path: 'pedidos',
				loadComponent: () => import('./features/orders/orders.page').then((page) => page.OrdersPage),
			},
			{
				path: 'ventas',
				loadComponent: () => import('./features/sales/sales.page').then((page) => page.SalesPage),
			},
			{
				path: 'productos',
				canActivate: [adminGuard],
				loadComponent: () => import('./features/menu/menu.page').then((page) => page.MenuPage),
			},
			{
				path: 'mesas',
				canActivate: [adminGuard],
				loadComponent: () => import('./features/tables/tables.page').then((page) => page.TablesPage),
			},
			{
				path: 'inventario',
				canActivate: [adminGuard],
				loadComponent: () => import('./features/inventory/inventory.page').then((page) => page.InventoryPage),
			},
			{
				path: 'personal',
				canActivate: [adminGuard],
				loadComponent: () => import('./features/staff/staff.page').then((page) => page.StaffPage),
			},
		],
	},
	{ path: '**', redirectTo: 'login' },
];
