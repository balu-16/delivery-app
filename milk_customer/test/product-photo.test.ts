/// <reference types="jest" />
import { act, renderHook } from '@testing-library/react-native';
import { images } from '../constants/assets';
import { useProductPhoto } from '../components/connected/useProductPhoto';

jest.mock('../src/api/client', () => ({apiBaseUrl: () => 'https://api.example.test'}));

test('uses an illustrative dairy photo after the catalog image fails and retries a new URL', async () => {
  const {result, rerender} = await renderHook(
    ({path, name}: {path: string; name: string}) => useProductPhoto(path, name),
    {initialProps: {path:'/media/missing', name:'Fresh milk'}},
  );
  expect(result.current.source).toEqual({uri:'https://api.example.test/media/missing'});
  await act(() => {result.current.onError();});
  expect(result.current.source).toBe(images.categoryMilk);
  expect(result.current.illustrative).toBe(true);
  await rerender({path:'/media/replaced', name:'Fresh milk'});
  expect(result.current.source).toEqual({uri:'https://api.example.test/media/replaced'});
  expect(result.current.illustrative).toBe(false);
});

test('chooses the correct dairy illustration and avoids inventing unrelated product photos', async () => {
  const {result, rerender} = await renderHook(
    ({name}: {name: string}) => useProductPhoto(null, name),
    {initialProps: {name:'Buttermilk'}},
  );
  expect(result.current.source).toBe(images.categoryButtermilk);
  await rerender({name:'Paneer'});
  expect(result.current.source).toBe(images.categoryPaneer);
  await rerender({name:'Apple'});
  expect(result.current.source).toBeNull();
  expect(result.current.illustrative).toBe(false);
});
