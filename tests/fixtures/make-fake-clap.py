"""Writes fake-clap.onnx: a stand-in for the CLAP audio encoder
(Xenova/clap-htsat-unfused, onnx/audio_model_quantized.onnx) with the same
input and output names and shapes, for the browser test (the real model is
~34 MB). It averages the log-mel features over time and projects the 64
bands to 512 numbers with a fixed matrix, so similar-sounding audio still
gives similar vectors.

    python3 -m pip install onnx numpy && python3 tests/fixtures/make-fake-clap.py
"""
import os
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

rng = np.random.default_rng(1)
proj = numpy_helper.from_array(rng.standard_normal((64, 512)).astype(np.float32), "proj")
shape = numpy_helper.from_array(np.array([-1, 64], dtype=np.int64), "shape")
graph = helper.make_graph(
    [
        helper.make_node("ReduceMean", ["input_features"], ["mean"], axes=[2], keepdims=0),  # [B, 1, 64]
        helper.make_node("Reshape", ["mean", "shape"], ["flat"]),  # [B, 64]
        helper.make_node("MatMul", ["flat", "proj"], ["audio_embeds"]),  # [B, 512]
    ],
    "fake_clap",
    [helper.make_tensor_value_info("input_features", TensorProto.FLOAT, ["batch", 1, 1001, 64])],
    [helper.make_tensor_value_info("audio_embeds", TensorProto.FLOAT, ["batch", 512])],
    initializer=[proj, shape],
)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
model.ir_version = 8
onnx.checker.check_model(model)
onnx.save(model, os.path.join(os.path.dirname(__file__), "fake-clap.onnx"))
