import { Redirect } from 'expo-router';
// The live catalogue owns product details; old demo product IDs are no longer valid.
export default function ProductDetail() { return <Redirect href="/products" />; }
