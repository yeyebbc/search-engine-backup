import lz4.block

input_file = 'search.json.mozlz4'
output_file = 'search.json'

with open(input_file, 'rb') as f:
    # Read and verify the custom Mozilla header
    magic = f.read(8)
    if magic != b'mozLz40\0':
        print("Invalid mozlz4 file!")
        exit(1)
    
    # Read the rest of the compressed data
    compressed_data = f.read()

# Decompress and save
decompressed_data = lz4.block.decompress(compressed_data)

with open(output_file, 'wb') as f:
    f.write(decompressed_data)

print(f"Successfully decompressed to {output_file}")