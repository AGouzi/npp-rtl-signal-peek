module gate_and (
    input  wire engine_data,
    output wire and_out
);
    assign and_out = engine_data & engine_data;
endmodule
