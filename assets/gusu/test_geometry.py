import math
import unittest

from geometry import (
    polygon_area,
    project_rings,
    roof_patches,
    roof_point,
    wall_edges,
)


class FootprintGeometryTests(unittest.TestCase):
    def assert_coverage(self, rings):
        patches = roof_patches(rings)
        expected = abs(polygon_area(rings[0])) - sum(
            abs(polygon_area(hole)) for hole in rings[1:]
        )
        self.assertAlmostEqual(sum(abs(polygon_area(p)) for p in patches), expected, places=7)
        return patches

    def test_long_rectangle_keeps_outline_and_ridge_orientation(self):
        rings = [[(0, 0), (24, 0), (24, 7), (0, 7), (0, 0)]]
        patches = self.assert_coverage(rings)
        self.assertEqual(len(patches), 1)
        patch = patches[0]
        ridge_start = roof_point(patch, 0, 0.5, 12.8)
        ridge_end = roof_point(patch, 1, 0.5, 12.8)
        self.assertAlmostEqual(abs(ridge_end[0] - ridge_start[0]), 24)
        self.assertAlmostEqual(ridge_end[1], ridge_start[1])
        self.assertAlmostEqual(ridge_start[2], 13.3)

    def test_rotated_quad_is_not_replaced_with_axis_aligned_prefab(self):
        angle = math.radians(32)
        ring = [
            (x * math.cos(angle) - y * math.sin(angle),
             x * math.sin(angle) + y * math.cos(angle))
            for x, y in [(0, 0), (8, 0), (8, 29), (0, 29)]
        ]
        patches = self.assert_coverage([ring])
        self.assertEqual(len(patches), 1)
        self.assertEqual(set(patches[0]), set(ring))
        start = roof_point(patches[0], 0, 0.5, 12.8)
        end = roof_point(patches[0], 1, 0.5, 12.8)
        self.assertAlmostEqual(math.dist(start, end), 29)

    def test_irregular_courtyard_keeps_hole_and_concave_outline(self):
        outer = [(0, 0), (25, 0), (25, 32), (17, 32), (17, 38),
                 (0, 38), (0, 0)]
        hole = [(6, 9), (6, 22), (18, 22), (18, 9), (6, 9)]
        patches = self.assert_coverage([outer, hole])
        for patch in patches:
            for u in (0.01, 0.25, 0.5, 0.75, 0.99):
                for v in (0.01, 0.25, 0.5, 0.75, 0.99):
                    x, y, z = roof_point(patch, u, v, 12.8)
                    self.assertFalse(6 < x < 18 and 9 < y < 22)
                    self.assertFalse(17 < x < 25 and 32 < y < 38)
                    self.assertLessEqual(z, 13.3)
                    self.assertGreater(z, 0.5)

    def test_walls_include_courtyard_edges_without_closure_duplicates(self):
        outer = [(0, 0), (20, 0), (20, 30), (0, 30), (0, 0)]
        hole = [(5, 5), (5, 10), (10, 10), (10, 5), (5, 5)]
        edges = wall_edges([outer, hole])
        self.assertEqual(len(edges), 8)
        self.assertEqual(sum(edge["courtyard"] for edge in edges), 4)
        self.assertTrue(all(math.dist(edge["start"], edge["end"]) > 0 for edge in edges))
        self.assertAlmostEqual(sum(math.dist(e["start"], e["end"]) for e in edges), 120)

    def test_projection_retains_every_source_vertex_and_hole(self):
        rings = [
            [[120.628, 31.316], [120.6282, 31.316],
             [120.6282, 31.3163], [120.628, 31.316]],
            [[120.62805, 31.31605], [120.6281, 31.31605],
             [120.6281, 31.3161], [120.62805, 31.31605]],
        ]
        projected = project_rings(rings, [120.628, 31.316])
        self.assertEqual([len(r) for r in projected], [4, 4])
        self.assertEqual(projected[0][0], (0.0, 0.0))
        self.assertGreater(projected[0][1][0], 18)
        self.assertAlmostEqual(projected[0][1][1], 0, delta=0.0001)
        self.assertGreater(projected[0][2][1], 33)
        self.assertEqual(projected[1][0], projected[1][-1])

    def test_height_envelope_and_curved_eaves(self):
        patch = roof_patches([[(0, 0), (20, 0), (20, 8), (0, 8)]])[0]
        for height in (4, 12.8, 25):
            samples = [roof_point(patch, 0.5, step / 100, height)[2]
                       for step in range(101)]
            self.assertAlmostEqual(max(samples), height + 0.5)
            self.assertGreater(min(samples), 0.5)
            self.assertEqual(samples[0], samples[-1])
            self.assertLess(samples[25], (samples[0] + samples[50]) / 2)


if __name__ == "__main__":
    unittest.main()
